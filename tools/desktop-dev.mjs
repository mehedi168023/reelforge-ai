// Runs the desktop app against Vite's dev server, with hot reload for the page code.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'vite';

const server = await createServer({ server: { port: 5173, strictPort: false } });
await server.listen();
const url = server.resolvedUrls.local[0];
console.log(`Vite ready at ${url}`);

const electron = createRequire(import.meta.url)('electron');
const child = spawn(electron, ['.'], { stdio: 'inherit', env: { ...process.env, RF_DEV_URL: url.replace(/\/$/, '') } });
child.on('close', async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
