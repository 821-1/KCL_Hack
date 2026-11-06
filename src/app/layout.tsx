import { Metadata } from "next";

export const metadata: Metadata = {
  title: "Next.js OSM Map (TS)",
  description: "Displaying OSM GeoJSON using MapLibre GL JS and TypeScript",
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