import { experimental_upgradeWebSocket } from '@vercel/functions';
import { joinCanvas, registerCanvasSocket, unregisterCanvasSocket, handleCanvasMessage } from '../lib/crayon.js';

export function GET() {
  return experimental_upgradeWebSocket((ws) => {
    registerCanvasSocket(ws);
    ws.on('message', (data) => {
      let message;
      try { message = JSON.parse(data.toString()); } catch { return; }
      if (message.type === 'join') void joinCanvas(ws, message.id);
      else if (message.type === 'leave') { void unregisterCanvasSocket(ws); ws.close(); }
      else void handleCanvasMessage(ws, message);
    });
    const cleanup = () => void unregisterCanvasSocket(ws);
    ws.on('close', cleanup);
    ws.on('error', cleanup);
  });
}

