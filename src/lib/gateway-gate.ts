import { Adapter } from 'socket.io-adapter';
import type { Server } from 'socket.io';

/** Single-API-process authorization gate. Scale-out requires distributed invalidation. */
class AccessGate {
    private readers = 0;
    private writing = false;
    private queue: Array<{ write: boolean; start: () => void }> = [];
    private broadcasts: Array<() => void> = [];

    private drain() {
        if (this.writing) return;
        while (this.queue.length) {
            if (this.queue[0].write && this.readers) return;
            const next = this.queue.shift()!;
            next.start();
            if (next.write) return;
        }
        for (const send of this.broadcasts.splice(0)) send();
    }

    async run<T>(write: boolean, action: () => Promise<T>): Promise<T> {
        await new Promise<void>(resolve => {
            this.queue.push({ write, start: () => {
                if (write) this.writing = true;
                else this.readers++;
                resolve();
            } });
            this.drain();
        });
        try { return await action(); }
        finally {
            if (write) this.writing = false;
            else this.readers--;
            this.drain();
        }
    }

    broadcast(send: () => void) {
        if (this.writing || this.queue.some(item => item.write)) this.broadcasts.push(send);
        else send();
    }
}

const gates = new WeakMap<Server, AccessGate>();
function gate(io: Server) {
    let value = gates.get(io);
    if (!value) { value = new AccessGate(); gates.set(io, value); }
    return value;
}
export const readGatewayAccess = <T>(io: Server, action: () => Promise<T>) => gate(io).run(false, action);
export const writeGatewayAccess = <T>(io: Server, action: () => Promise<T>) => gate(io).run(true, action);

/** All room broadcasts (REST, assistant streams, presence, Redis) use this gate. */
export function installGatewayGate(io: Server) {
    io.adapter(class extends Adapter {
        override broadcast(...args: Parameters<Adapter['broadcast']>) {
            // Resolve recipients at delivery time, after revoked sockets leave rooms.
            gate(io).broadcast(() => super.broadcast(...args));
        }
    });
}
