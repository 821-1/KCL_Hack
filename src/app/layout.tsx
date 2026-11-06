import { Metadata } from "next";

export const metadata: Metadata = {
  title: "飯塚バスマップ",
  description: "iizuka_bus_map",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ja">
      <body style={{ margin: 0, padding: 0, overflow: "hidden" }}>
        {children}
      </body>
    </html>
  );
}