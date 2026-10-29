import {PARCEL_ICON_URL} from './branding';
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Parcel Gmail Importer",
  description: "Private Parcel import setup and status.",
  other: {
    "codex-preview": "development",
  },
  icons: {
    icon: PARCEL_ICON_URL,
    shortcut: PARCEL_ICON_URL,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
