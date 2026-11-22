#!/usr/bin/env python3
# `qb run`'s relay: runs an agent's command in a terminal QueueBox owns, so the board can type into it. The person
# sees and types exactly as before (raw mode, window size kept in step); anything written to the unix socket
# QUEUEBOX_PTY names is typed into the agent's terminal too. Standard library only; any agent CLI on any model.
#
#   ptyrun.py <socket path> <command> [args...]

import errno, fcntl, os, pty, select, signal, socket, struct, sys, termios, tty

def winsize(fd):
    try:
        return fcntl.ioctl(fd, termios.TIOCGWINSZ, b'\0' * 8)
    except OSError:
        return struct.pack('HHHH', 24, 80, 0, 0)

def main():
    if len(sys.argv) < 3:
        sys.stderr.write('usage: ptyrun.py <socket> <command> [args...]\n')
        return 2
    sock_path, argv = sys.argv[1], sys.argv[2:]
    os.makedirs(os.path.dirname(sock_path), exist_ok=True)
    try:
        os.unlink(sock_path)
    except FileNotFoundError:
        pass
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(sock_path)
    os.chmod(sock_path, 0o600)
    server.listen(4)
    server.setblocking(False)

    stdin = sys.stdin.fileno()
    stdout = sys.stdout.fileno()
    interactive = os.isatty(stdin)
    size = winsize(stdin if interactive else stdout)

    pid, master = pty.fork()
    if pid == 0:
        os.environ['QUEUEBOX_PTY'] = sock_path
        try:
            os.execvp(argv[0], argv)
        except OSError as e:
            sys.stderr.write(f'qb run: {argv[0]}: {e.strerror}\n')
            os._exit(127)
    fcntl.ioctl(master, termios.TIOCSWINSZ, size)

    def resize(*_):
        if interactive:
            fcntl.ioctl(master, termios.TIOCSWINSZ, winsize(stdin))
            try:
                os.kill(pid, signal.SIGWINCH)
            except ProcessLookupError:
                pass
    signal.signal(signal.SIGWINCH, resize)

    saved = termios.tcgetattr(stdin) if interactive else None
    if interactive:
        tty.setraw(stdin)
    clients = []
    code = 0
    try:
        while True:
            fds = [master, server] + clients + ([stdin] if interactive else [])
            try:
                ready, _, _ = select.select(fds, [], [])
            except InterruptedError:
                continue
            if master in ready:
                try:
                    data = os.read(master, 65536)
                except OSError as e:
                    if e.errno != errno.EIO:
                        raise
                    data = b''
                if not data:
                    break
                os.write(stdout, data)
            if interactive and stdin in ready:
                data = os.read(stdin, 65536)
                if data:
                    os.write(master, data)
            if server in ready:
                try:
                    conn, _ = server.accept()
                    conn.setblocking(False)
                    clients.append(conn)
                except BlockingIOError:
                    pass
            for c in [c for c in clients if c in ready]:
                try:
                    data = c.recv(65536)
                except BlockingIOError:
                    continue
                if data:
                    os.write(master, data)
                else:
                    clients.remove(c)
                    c.close()
    finally:
        if saved is not None:
            termios.tcsetattr(stdin, termios.TCSAFLUSH, saved)
        server.close()
        try:
            os.unlink(sock_path)
        except FileNotFoundError:
            pass
        _, status = os.waitpid(pid, 0)
        code = os.waitstatus_to_exitcode(status)
    return code

if __name__ == '__main__':
    sys.exit(main())
