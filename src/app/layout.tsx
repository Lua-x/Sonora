import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Sonora · Dein Leben in Musik',
  description: 'Dein persönlicher, selbst gehosteter Musikrückblick. Hörverlauf, Entdeckungen und Lieblingssongs an einem Ort.',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="de" suppressHydrationWarning><body>{children}</body></html>;
}
