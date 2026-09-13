import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "有猫来信",
  description: "内部体验 · 小猫的来信与旅行",
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
