// The exact bytes a phone signs for one reading. The browser, the relay and the Node
// factory all build them here, so the relay can refuse a signature over anything else.
export function readingJSON({ deviceId, counter, opinion, grade, cell, lat, jitter, down, ts }) {
  return JSON.stringify({
    deviceId: String(deviceId).toLowerCase(), counter: String(counter),
    opinion, grade, cell: String(cell).toLowerCase(), lat, jitter, down, ts,
  });
}
