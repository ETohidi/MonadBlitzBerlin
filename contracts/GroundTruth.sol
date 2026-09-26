// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Attested observations from hardware-backed device keys, batch-committed.
/// The chain is not in any control loop: it is the record that is disputed later.
contract GroundTruth {
    address constant P256 = address(0x0100); // EIP-7951, 6900 gas

    enum Reason { Accepted, UnknownDevice, Revoked, StaleCounter, BadSignature }

    struct Device {
        bytes32 x;
        bytes32 y;
        uint64 lastCounter;
        uint128 trust;      // starts at 1000, moves with claim-vs-measurement honesty
        bool revoked;
    }

    struct Attestation {
        bytes32 deviceId;
        uint64 counter;
        uint8 opinion;       // what the human tapped: 0 unusable .. 3 excellent
        uint8 grade;         // what the hardware measured for the same instant
        bytes32 cell;        // coarse zone, self-selected; never a precise location
        bytes32 payloadHash; // keccak of the full signed reading
        bytes authenticatorData;
        bytes clientDataJSON;
        bytes derSignature;
    }

    mapping(bytes32 => Device) public devices;
    mapping(bytes32 => bool) public commitments; // keccak(deviceId, counter, payloadHash)
    uint256 public totalAccepted;
    uint256 public totalRejected;

    event Enrolled(bytes32 indexed deviceId, uint256 x, uint256 y);
    event Revoked(bytes32 indexed deviceId);
    event Committed(bytes32 indexed deviceId, uint64 counter, bytes32 cell, uint8 opinion, uint8 grade, uint128 trust);
    event Rejected(bytes32 indexed deviceId, Reason indexed reason, uint64 counter);

    function _p256(bytes32 h, bytes32 r, bytes32 s, uint256 x, uint256 y) private view returns (bool) {
        (bool ok, bytes memory out) = P256.staticcall(abi.encodePacked(h, r, s, x, y));
        return ok && out.length == 32 && abi.decode(out, (uint256)) == 1;
    }

    function _bytesToUint(bytes memory b, uint256 off, uint256 len) private pure returns (uint256 acc) {
        for (uint256 i = 0; i < len; i++) acc = (acc << 8) | uint8(b[off + i]);
    }

    /// DER: 30 <len> 02 <rlen> <r> 02 <slen> <s>. Leading zero bytes fall out via the shift.
    function _derToRS(bytes memory der) private pure returns (bytes32 r, bytes32 s) {
        if (der.length < 8 || der[0] != 0x30 || uint8(der[1]) != der.length - 2) return (0, 0);
        uint256 p = 2;
        if (der[p] != 0x02) return (0, 0);
        uint256 rlen = uint8(der[p + 1]);
        if (rlen == 0 || rlen > 33 || p + 2 + rlen > der.length) return (0, 0);
        r = bytes32(_bytesToUint(der, p + 2, rlen));
        p += 2 + rlen;
        if (der[p] != 0x02) return (0, 0);
        uint256 slen = uint8(der[p + 1]);
        if (slen == 0 || slen > 33 || p + 2 + slen != der.length) return (0, 0);
        s = bytes32(_bytesToUint(der, p + 2, slen));
    }

    /// WebAuthn: signedData = authenticatorData || sha256(clientDataJSON)
    function _hashOf(Attestation memory a) private pure returns (bytes32) {
        return sha256(abi.encodePacked(a.authenticatorData, sha256(a.clientDataJSON)));
    }

    /// Trust-on-first-enrol: only the private key holder can sign, so a verifying
    /// signature over (x, y) is proof of possession. No admin, no queue for 60 attendees.
    function enrol(bytes32 x, bytes32 y, Attestation calldata proof) external {
        bytes32 id = keccak256(abi.encodePacked(x, y));
        if (devices[id].x != 0) revert("exists");
        Attestation memory a = proof;
        (bytes32 r, bytes32 s) = _derToRS(a.derSignature);
        if (r == 0 || s == 0 || !_p256(_hashOf(a), r, s, uint256(x), uint256(y))) revert("proof");
        devices[id] = Device({x: x, y: y, lastCounter: 0, trust: 1000, revoked: false});
        emit Enrolled(id, uint256(x), uint256(y));
    }

    function revoke(bytes32 deviceId) external {
        require(devices[deviceId].x != 0, "unknown");
        require(!devices[deviceId].revoked, "revoked");
        devices[deviceId].revoked = true;
        emit Revoked(deviceId);
    }

    /// One transaction, many devices, one precompile call each. Never reverts on a bad
    /// attestation: a rejection is a result, and a result the room can see is worth more
    /// than a reverted transaction.
    function commitBatch(Attestation[] calldata atts) external returns (uint256 accepted, uint256 rejected) {
        for (uint256 i = 0; i < atts.length; i++) {
            Attestation memory a = atts[i];
            Device storage d = devices[a.deviceId];

            if (d.x == 0) {
                emit Rejected(a.deviceId, Reason.UnknownDevice, a.counter);
                rejected++;
                continue;
            }
            if (d.revoked) {
                emit Rejected(a.deviceId, Reason.Revoked, a.counter);
                rejected++;
                continue;
            }
            // Monotonic per-device counter: this is what makes a replayed reading detectable
            // and what makes a missing interval visible as a hole in the record.
            if (a.counter <= d.lastCounter) {
                emit Rejected(a.deviceId, Reason.StaleCounter, a.counter);
                rejected++;
                continue;
            }
            (bytes32 r, bytes32 s) = _derToRS(a.derSignature);
            if (r == 0 || s == 0 || !_p256(_hashOf(a), r, s, uint256(d.x), uint256(d.y))) {
                emit Rejected(a.deviceId, Reason.BadSignature, a.counter);
                rejected++;
                continue;
            }

            d.lastCounter = a.counter;
            commitments[keccak256(abi.encodePacked(a.deviceId, a.counter, a.payloadHash))] = true;
            d.trust = _score(d.trust, a.opinion, a.grade);
            accepted++;
            totalAccepted++;
            emit Committed(a.deviceId, a.counter, a.cell, a.opinion, a.grade, d.trust);
        }
        totalRejected += rejected;
    }

    /// Agreement with the hardware raises trust; a confident claim contradicted by the
    /// device's own measurement lowers it. This is the answer to reward farming: there is
    /// nothing to volume-mine, because redundant or dishonest readings cost the reporter.
    function _score(uint128 trust, uint8 opinion, uint8 grade) private pure returns (uint128) {
        uint256 gap = opinion > grade ? opinion - grade : grade - opinion;
        if (gap == 0) return uint128(trust + 25);
        if (gap == 1) return uint128(trust + 5);
        return uint128(trust > gap * 120 ? trust - uint128(gap * 120) : 0);
    }

    function isCommitted(bytes32 deviceId, uint64 counter, bytes32 payloadHash) external view returns (bool) {
        return commitments[keccak256(abi.encodePacked(deviceId, counter, payloadHash))];
    }
}
