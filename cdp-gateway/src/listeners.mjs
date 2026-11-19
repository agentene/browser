// Unix listener lifecycle shared by startup, rollback and orderly shutdown.
import fs from 'node:fs/promises';

export function closeServers(servers, sockets) {
  const closing = servers.filter((server) => server.listening).map((server) => new Promise((resolve, reject) => {
    server.close((err) => err ? reject(err) : resolve());
  }));
  // HTTP server.close() leaves upgraded WebSockets alive.
  for (const socket of sockets) socket.destroy();
  return Promise.all(closing);
}

export async function listenAll(listeners, sockets) {
  try {
    for (const { server, path } of listeners) {
      await fs.rm(path, { force: true });
      await new Promise((resolve, reject) => {
        const onError = (err) => { server.off('listening', onListening); reject(err); };
        const onListening = () => { server.off('error', onError); resolve(); };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(path);
      });
      // RUN_USER=0 leaves nginx workers as nobody. Use the same permissions
      // as the other services in the entrypoint-owned socket directory.
      await fs.chmod(path, 0o666);
    }
  } catch (err) {
    await closeServers(listeners.map(({ server }) => server), sockets);
    throw err;
  }
}
