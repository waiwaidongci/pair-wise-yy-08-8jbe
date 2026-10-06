import { CssBaseline, ThemeProvider, createTheme } from '@mui/material';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { migrateLegacyStorage } from './utils/storageMigration';

const theme = createTheme({
  palette: {
    mode: 'light',
    primary: { main: '#1769ff' },
    secondary: { main: '#0f9f7a' },
    warning: { main: '#d97706' },
    error: { main: '#c2413b' },
    background: { default: '#e8edf4', paper: '#ffffff' },
    text: { primary: '#172033', secondary: '#667085' },
  },
  shape: { borderRadius: 8 },
  typography: {
    fontFamily:
      '"PingFang SC", "Microsoft YaHei", system-ui, -apple-system, BlinkMacSystemFont, sans-serif',
    button: { textTransform: 'none', fontWeight: 600 },
  },
  components: {
    MuiButton: { defaultProps: { disableElevation: true } },
    MuiCard: { styleOverrides: { root: { backgroundImage: 'none' } } },
  },
});

// 必须在 Store 创建前执行：旧工程里内嵌的音频先迁移进 IndexedDB 素材库，
// Store 水合时拿到的就是“只有轨道、片段和素材索引”的新记录。
async function bootstrap() {
  await migrateLegacyStorage();
  const [{ App }, { HelpPage }, { StudioPage }, { Navigate, RouterProvider, createBrowserRouter }] =
    await Promise.all([
      import('./App'),
      import('./pages/HelpPage'),
      import('./pages/StudioPage'),
      import('react-router-dom'),
    ]);

  const router = createBrowserRouter([
    {
      path: '/',
      element: <App />,
      children: [
        { index: true, element: <Navigate to="/studio" replace /> },
        { path: 'studio', element: <StudioPage /> },
        { path: 'help', element: <HelpPage /> },
      ],
    },
  ]);

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <RouterProvider router={router} />
      </ThemeProvider>
    </StrictMode>,
  );
}

void bootstrap();
