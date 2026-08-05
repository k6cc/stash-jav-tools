import sys


def __prefix(level_char):
    start_level_char = b'\x01'
    end_level_char = b'\x02'
    ret = start_level_char + level_char + end_level_char
    return ret.decode()


def __log(level_char, s):
    if level_char == "":
        return
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
