import type { Metadata } from "next";
import { Outfit } from "next/font/google";
import "./globals.css";
import "./page.css";

const outfit = Outfit({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700", "800", "900"],
});

export const metadata: Metadata = {
  title: "Zeplin X - Rezervasyon Sistemi",
  description: "Zeplin X rezervasyon ve seans yönetimi paneli.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="tr">
      <body className={outfit.className}>{children}</body>
    </html>
  );
}
