import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Tabs } from '@mantine/core';
import Header from '../components/app-shell/Header';
import { contentRegion } from '../styles/app-shell.css';
import { pagePad } from '../styles/management.css';

// Admin area is a first-class navigation section (CHANGELOG v1.2), only
// reachable by admins via RequireAdmin. Tabs follow the URL so each page
// (/admin/users, /admin/jobs, /admin/system) is a stable deep link.
export default function AdminLayout() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const value = pathname.split('/')[2] || 'users';

  return (
    <>
      <Header breadcrumb="管理" />
      <div className={`${contentRegion} ${pagePad}`}>
        <Tabs
          value={value}
          onChange={(v) => v && navigate(`/admin/${v}`)}
          styles={{ tab: { fontSize: 13 } }}
        >
          <Tabs.List mb="md">
            <Tabs.Tab value="users">用户</Tabs.Tab>
            <Tabs.Tab value="jobs">后台任务</Tabs.Tab>
            <Tabs.Tab value="system">系统设置</Tabs.Tab>
          </Tabs.List>

          <Outlet />
        </Tabs>
      </div>
    </>
  );
}
