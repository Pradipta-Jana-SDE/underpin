import './globals.css';

export const metadata = {
  title: 'Underpin Studio',
  description: 'Point it at a website. Get a real Next.js project back.'
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
