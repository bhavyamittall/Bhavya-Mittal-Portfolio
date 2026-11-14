import { experimental_upgradeWebSocket } from '@vercel/functions';
import { joinCanvas, registerCanvasSocket, unregisterCanvasSocket, handleCanvasMessage } from '../lib/crayon.js';

export function GET() {
  return experimental_upgradeWebSocket((ws) => {
    registerCanvasSocket(ws);
    let queue = Promise.resolve();
    ws.on('message', (data) => {
      queue = queue.then(async () => {
        if (data.length > 32_000) { ws.close(1009, 'Message too large'); return; }
        let message;
        try { message = JSON.parse(data.toString()); } catch { return; }
        if (message.type === 'join') await joinCanvas(ws, message.id);
        else if (message.type === 'leave') { await unregisterCanvasSocket(ws); ws.close(); }
        else await handleCanvasMessage(ws, message);
      }).catch((error) => console.error('[crayon] message handling failed', error));
    });
    const cleanup = () => void unregisterCanvasSocket(ws);
    ws.on('close', cleanup);
    ws.on('error', cleanup);
  });
}

