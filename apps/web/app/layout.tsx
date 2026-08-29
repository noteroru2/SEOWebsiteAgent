import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'SEO Website Agent',
  description: 'Owner-operated SEO monitoring and review console',
  robots: { index: false, follow: false },
};
const nav = [
  ['/', 'ภาพรวม'],
  ['/sites', 'เว็บไซต์'],
  ['/opportunities', 'โอกาส SEO'],
  ['/jobs', 'งานของระบบ'],
  ['/serp-providers', 'แหล่งข้อมูลอันดับ'],
  ['/approvals', 'รออนุมัติ'],
] as const;
export default function Layout({ children }: Readonly<{ children: React.ReactNode }>) {
  const production = process.env.NODE_ENV === 'production';
  return (
    <html lang="th">
      <body>
        <div className="shell">
          <aside>
            <div className="brand">
              <span className="mark">S</span>
              <div>
                SEO Website Agent<small>{production ? 'Production' : 'Local development'}</small>
              </div>
            </div>
            <nav>
              {nav.map(([href, label]) => (
                <Link key={href} href={href}>
                  {label}
                </Link>
              ))}
            </nav>
            <div className="local">
              ● {production ? 'Production environment' : 'Local environment'}
            </div>
          </aside>
          <main>{children}</main>
        </div>
      </body>
    </html>
  );
}
