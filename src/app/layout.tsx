import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ledgerline / Agentic Treasury Control",
  description:
    "A deterministic guardrail between AI agents and Airwallex money movement. Intents are proposed by a model, decided by a policy engine.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
