import type { WebSocket } from 'ws';

export interface Client {
  id: string;
  socket: WebSocket;
  userId: string;
  name: string;
  vaultId: string;
  nodeId: string | null;
}

const clients = new Set<Client>();

function send(c: Client, data: string) {
  if (c.socket.readyState === 1) c.socket.send(data);
}

export const hub = {
  add(c: Client) { clients.add(c); this.presence(c.vaultId); },
  remove(c: Client) { if (clients.delete(c)) this.presence(c.vaultId); },

  toVault(vaultId: string, msg: Record<string, unknown>) {
    const data = JSON.stringify(msg);
    for (const c of clients) if (c.vaultId === vaultId) send(c, data);
  },
  toUser(userId: string, msg: Record<string, unknown>) {
    const data = JSON.stringify(msg);
    for (const c of clients) if (c.userId === userId) send(c, data);
  },
  presence(vaultId: string) {
    const users = [...clients].filter((c) => c.vaultId === vaultId)
      .map((c) => ({ clientId: c.id, userId: c.userId, name: c.name, nodeId: c.nodeId }));
    this.toVault(vaultId, { t: 'presence', users });
  },
  // доступ отозван или хранилище удалено
  kick(vaultId: string, userId?: string) {
    for (const c of clients) if (c.vaultId === vaultId && (!userId || c.userId === userId)) c.socket.close(4403, 'access revoked');
  },
};
