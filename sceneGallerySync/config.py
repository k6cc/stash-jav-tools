# sceneGallerySync 配置文件
# 修改后无需重启 Stash，下次触发时自动生效

# ============================================================
# 图片文件名配置
# ============================================================

# 封面文件名列表（按顺序查找，使用第一个找到的）
# {filename} 替换为影片文件名（不含扩展名）
# 多碟影片会按文件名链逐级尝试（如 ABP-998-C-cd1 → ABP-998-C → ABP-998）
poster_filenames = "{filename}-poster.jpg,folder.jpg"

# fanart 文件名列表（所有找到的文件都导入图库）
# {filename} 替换为影片文件名（不含扩展名）
# 与封面不同，fanart 列表中所有存在的文件都会被导入
fanart_filenames = "{filename}-fanart.jpg,landscape.jpg"

# ============================================================
# extrafanart 文件夹配置
# ============================================================

# extrafanart 文件夹名列表（按顺序查找第一个存在的）
# 文件夹不存在或内部无图片文件则不创建图库
# 这是创建图库的必要条件，封面和 fanart 为可选
extrafanart_folders = "extrafanart"

# ============================================================
# 图片格式配置
# ============================================================

# 支持的图片扩展名（逗号分隔，含点号）
# extrafanart 文件夹内仅导入这些扩展名的文件
# 如需支持更多格式可添加，如 ".bmp"、".tiff"
image_extensions = ".jpg,.jpeg,.png,.gif,.webp"

# ============================================================
# 标题后缀剥离配置
# ============================================================

# 标题后缀剥离模式（每行一个正则表达式）
# 这些模式会按顺序循环剥离，直到无后缀可剥
# 用于让不同版本（CD分集、字幕版、无码版等）的影片关联同一图库
title_suffix_patterns = """
CD\\d+                          # CD1, CD2, CD3
Disc\\d+                        # Disc1, Disc2
Part\\d+                        # Part1, Part2
Pt\\d+                          # Pt1, Pt2
[a-zA-Z]                        # A, B, C (单字母版本/字幕)
\\d+K                           # 4K, 8K (分辨率)
无码|无插件|破解|中文字幕|字幕|高清|超清  # 中文类型后缀
"""

# ============================================================
# 后台任务配置
# ============================================================

# 过期任务文件清理时间（秒）
# .sgs_pending/ 目录中超过此时间的任务文件会被自动清理
# 默认 3600 秒（1小时）
stale_file_max_age = 3600


def get_poster_filenames():
    return [f.strip() for f in poster_filenames.split(",") if f.strip()]


def get_fanart_filenames():
    return [f.strip() for f in fanart_filenames.split(",") if f.strip()]


def get_extrafanart_folders():
    return [f.strip() for f in extrafanart_folders.split(",") if f.strip()]


def get_image_extensions():
    return set(f.strip().lower() for f in image_extensions.split(",") if f.strip())


def get_stale_file_max_age():
    try:
        return int(stale_file_max_age)
    except (ValueError, TypeError):
        return 3600


def get_title_suffix_patterns():
    """解析 title_suffix_patterns 配置，返回正则表达式列表"""
    patterns = []
    for line in title_suffix_patterns.strip().split('\n'):
        line = line.strip()
        # 跳过空行和注释行
        if not line or line.startswith('#'):
            continue
        # 移除行尾注释
        if '#' in line:
            line = line.split('#')[0].strip()
        if line:
            patterns.append(r'\s+' + line + r'$')
    return patterns if patterns else [r'\s+(?:CD|Disc|Part|Pt)\d+$', r'\s+[a-zA-Z]$']
