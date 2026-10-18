# ImageMetaSync 配置文件
# 修改后无需重启 Stash，下次触发时自动生效
#
# 注意：插件行为设置（写入哪些字段 / 排除 tag / 覆盖模式 / 无图库场景兜底）
# 在 Stash 的「设置 → 插件 → ImageMetaSync」页面配置，不在本文件。
# 本文件只放文件命名约定与后台任务参数。

# ============================================================
# 图片文件名配置（仅「无图库场景」兜底路径使用）
# ============================================================

# 封面文件名列表（按顺序查找，使用第一个找到的）
# {filename} 替换为影片文件名（不含扩展名）；多碟影片按文件名链逐级尝试
poster_filenames = "{filename}-poster.jpg,folder.jpg"

# fanart 文件名列表（所有找到的都处理）
fanart_filenames = "{filename}-fanart.jpg,landscape.jpg"

# ============================================================
# 后台任务配置
# ============================================================

# 过期任务文件清理时间（秒）
stale_file_max_age = 3600

# 运行锁过期时间（秒）：超过此时间的锁视为持有进程已崩溃，可抢占
lock_stale_max_age = 900


def get_poster_filenames():
    return [f.strip() for f in poster_filenames.split(",") if f.strip()]


def get_fanart_filenames():
    return [f.strip() for f in fanart_filenames.split(",") if f.strip()]


def get_stale_file_max_age():
    try:
        return int(stale_file_max_age)
    except (ValueError, TypeError):
        return 3600


def get_lock_stale_max_age():
    try:
        return int(lock_stale_max_age)
    except (ValueError, TypeError):
        return 900
