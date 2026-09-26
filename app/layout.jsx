export const metadata = {
  title: 'Ground Truth — attested coverage, by the people standing in it',
  description: 'Your phone signs what it measures. The record is made before anyone knows whether it is convenient.',
  viewport: 'width=device-width, initial-scale=1, maximum-scale=1',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, background: '#0b0d10', color: '#e8edf2', font: '16px/1.45 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif' }}>
        {children}
      </body>
    </html>
  );
}
