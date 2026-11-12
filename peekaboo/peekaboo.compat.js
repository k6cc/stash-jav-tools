/* Peekaboo —— 其他插件支持索引
 *
 * 一个插件一段，互不影响：改某个插件的兼容只动它自己那段，peekaboo.js 不用碰。
 * 新增一个插件 = 在下面数组里加一段，填需要的字段。
 *
 * 字段（都可省略，不填就是“那边没有这类东西”）：
 *   id    插件 id，仅用于区分段落
 *   host  悬停 / 长按可以整块露原图的容器（小卡、浮层）
 *   unit  库里的字段文字：一块只出一条替换结果（名字、别名、统计行、标题、标签、字段值）
 *   desc  整句文字（简介）：遮罩按句首大写，自动也算 unit
 *   attr  被塞进控件 title/alt 的库内容（控件本身免遮，但这两个属性要遮）
 *   bg    背景图形式的画面：命中就遮，不看 URL（外站直链的封面认不出来）
 *   tail  「名字 · 计数」只遮名字、计数留着（计数是插件自己的统计，不是库内容）
 *
 * 不写进来的：插件自己的按钮文字、表单、搜索/导入弹窗 —— 那些是操作对象，
 * 遮了就没法确认自己在点什么、在导什么。
 *
 * 本文件必须排在 peekaboo.js 之前（见 peekaboo.yml 的 ui.javascript 顺序）。
 */
window.__peekabooCompat = [
  // ══ stashDiscover ══════════════════════════════════════════════════════════
  // 覆盖：演员小卡（发现页 mini 卡）、本地演员展开（演员过滤视图头部）、
  //       工作室钻取（入口药丸 + 展开后的头部）、场景详情弹窗（.ssd-modal）、
  //       外部演员弹窗（.ssd-dp-modal）、列表表格视图。
  // 详情视图/弹窗只遮不整块露：图仍可单张悬停，文字要靠 Shift 或 Reveal text as well。
  {
    id: "stashDiscover",
    host: [".ssd-dp-mini", ".ssd-performer-card"],
    unit: [
      // 演员小卡
      ".ssd-dp-mini-name", ".ssd-dp-mini-sub",
      // 演员详情头部（本地展开与外部弹窗同一个模块）
      ".ssd-dp-pfname", ".ssd-dp-pfalias", ".ssd-dp-pfgender", ".ssd-dp-pfstat",
      // 工作室钻取：入口药丸与展开后的头部（名字、副标题「N 部新作品 · 最新 <日期>」）
      ".ssd-dp-grpchip", ".ssd-dp-pfmeta",
      // 场景弹窗里的演员浮窗
      ".ssd-perf-age",
      // 场景详情弹窗：标题、元数据值（番号/日期/时长/导演/工作室）、演员与标签药丸
      ".ssd-modal-title", ".ssd-meta-value", ".ssd-pill", ".ssd-pill-text",
      // 表格视图（与卡片视图同一批数据）
      ".ssd-scene-table .title-data .ellips-data",
      ".ssd-scene-table .date-data",
      ".ssd-scene-table .scene_code-data",
      ".ssd-scene-table .studio-data .ellips-data",
      ".ssd-scene-table .performers-data li",
      ".ssd-scene-table .tags-data li"
    ],
    desc: [".ssd-synopsis-text"],
    // 药丸按钮把演员名挂在 title 上；封面/头像的 alt 是标题与人名
    attr: [
      ".ssd-pill-performer",
      ".ssd-scene-table .title-data a",
      ".ssd-scene-card img", ".ssd-scene-table img",
      ".ssd-modal img", ".ssd-dp-modal img", ".ssd-dp-page img", ".ssd-performer-card img"
    ],
    bg: [".ssd-carousel-hero", ".ssd-dp-studiopic"],
    tail: [".ssd-dp-grpchip"]
  }
];
