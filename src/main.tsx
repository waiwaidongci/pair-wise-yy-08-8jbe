import { CssBaseline, ThemeProvider, createTheme } from '@mui/material';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Navigate, RouterProvider, createBrowserRouter } from 'react-router-dom';
import { App } from './App';
import { HelpPage } from './pages/HelpPage';
import { StudioPage } from './pages/StudioPage';
import { migrationReady } from './utils/assetLibrary';
import './styles.css';

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

const container = document.getElementById('root')!;

async function bootstrap() {
  container.innerHTML = '<div class="boot-loading">正在打开素材库…</div>';
  try {
    await migrationReady;
  } catch {
    // 迁移失败不应阻止进入工作站，片段会在缺失声音时给出提示。
  }
  createRoot(container).render(
    <StrictMode>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <RouterProvider router={router} />
      </ThemeProvider>
    </StrictMode>,
  );
}

void bootstrap();
