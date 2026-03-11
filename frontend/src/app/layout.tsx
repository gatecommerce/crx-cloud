import type { Metadata } from "next";
import { Inter, Geist } from "next/font/google";
import "./globals.css";
import { cn } from "@/lib/utils";

const geist = Geist({subsets:['latin'],variable:'--font-sans'});

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "CRX Cloud — AI-Powered Multi-CMS Hosting Panel",
  description: "Deploy and manage Odoo, WordPress, PrestaShop on any infrastructure. Powered by AI.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={cn("dark", "font-sans", geist.variable)}>
      <body className={`${inter.className} bg-[var(--background)] text-[var(--foreground)] antialiased`}>
        {children}
      </body>
    </html>
  );
}
