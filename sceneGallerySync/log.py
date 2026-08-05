import sys

_plain = False

_LEVEL_NAMES = {
    b't': 'TRACE',
    b'd': 'DEBUG',
    b'i': 'INFO',
    b'w': 'WARN',
    b'e': 'ERROR',
    b'p': 'PROGRESS',
}


def set_plain(p):
    """后台模式使用纯文本日志（写入文件），不带 stash 协议前缀"""
    global _plain
    _plain = p


def __prefix(level_char):
    start_level_char = b'\x01'
    end_level_char = b'\x02'
    ret = start_level_char + level_char + end_level_char
    return ret.decode()


def __log(level_char, s):
    if level_char == "":
        return
    if _plain:
        level_name = _LEVEL_NAMES.get(level_char, level_char.decode('ascii', 'replace'))
        print(f"[{level_name}] {s}", file=sys.stderr, flush=True)
    else:
        print(__prefix(level_char) + s + "\n", file=sys.stderr, flush=True)


def LogTrace(s):
    __log(b't', s)


def LogDebug(s):
    __log(b'd', s)


def LogInfo(s):
    __log(b'i', s)


def LogWarning(s):
    __log(b'w', s)


def LogError(s):
    __log(b'e', s)


def LogProgress(p):
    progress = min(max(0, p), 1)
    __log(b'p', str(progress))
