export const metadata = { title: "voicebox", robots: { index: false } };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "ui-monospace, monospace", background: "#101113", color: "#ece6da", padding: 32 }}>{children}</body>
    </html>
  );
}
