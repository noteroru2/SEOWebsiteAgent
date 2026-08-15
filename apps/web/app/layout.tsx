import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'SEO Website Agent',
  description: 'Local-first SEO operations foundation',
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
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <aside>
            <div className="brand">
              <span className="mark">S</span>
              <div>
                SEO Website Agent<small>Local pilot</small>
              </div>
            </div>
            <nav>
              {nav.map(([href, label]) => (
                <Link key={href} href={href}>
                  {label}
                </Link>
              ))}
            </nav>
            <div className="local">● Local environment</div>
          </aside>
          <main>{children}</main>
        </div>
      </body>
    </html>
  );
}
