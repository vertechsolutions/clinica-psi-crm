import type { Metadata, Viewport } from 'next';
import { Montserrat, DM_Sans } from 'next/font/google';
import './globals.css';

const display = Montserrat({
  variable: '--font-display',
  subsets: ['latin'],
  weight: ['600', '700', '800'],
});

const body = DM_Sans({
  variable: '--font-body',
  subsets: ['latin'],
  weight: ['400', '500', '600'],
});

export const metadata: Metadata = {
  title: 'Clínica Cazule — Painel de Triagem (demo Vertech)',
  description: 'Triagem inteligente no WhatsApp + distribuição de pacientes. Demonstração com dados fictícios.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="pt-BR" className={`${display.variable} ${body.variable} antialiased`}>
      <body>{children}</body>
    </html>
  );
}
