# -*- coding: utf-8 -*-
"""跑任意插件的 runPluginOperation，参数走 JSON（避开 shell 引号地狱）。

为什么需要它：插件 op 的参数常带多行规则、正则、嵌套 key，
在 bash/PowerShell 里内联会被引号、`$`、`!`、反斜杠吃掉；
GraphQL 变量用 `Map!` 时更是没法直接写在命令行里。

用法（在任意目录）：
  python tests/SceneBackfill/sf_op.py SceneBackfill '{"mode":"capture","lang":"zh"}'
  python tests/SceneBackfill/sf_op.py SceneBackfill --file args.json
  python tests/SceneBackfill/sf_op.py SceneBackfill '{"mode":"rules","save":"true"}' --raw

约定：
  - `--file` 读 UTF-8 JSON 文件；不给则用第一个位置参数当 JSON 串
  - 默认只打印 runPluginOperation 的返回值（缩进 JSON，中文不转义）
  - `--raw` 打印整包 GraphQL 响应，用于看 errors
  - `--page` 不用（要页面上下文请走 stash_dev.py gql --page）
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
from stash_client import Stash  # noqa: E402

Q = 'mutation($id:ID!,$a:Map!){runPluginOperation(plugin_id:$id,args:$a)}'


def main(argv):
    argv = argv[1:]
    raw = "--raw" in argv
    argv = [a for a in argv if a != "--raw"]
    if not argv:
        print(__doc__)
        return 1

    plugin = argv.pop(0)
    args = {}
    if argv and argv[0] == "--file":
        with open(argv[1], "r", encoding="utf-8") as f:
            args = json.load(f)
    elif argv:
        args = json.loads(argv[0])

    s = Stash()
    data = s.gql(Q, {"id": plugin, "a": args})
    if raw:
        print(json.dumps(data, ensure_ascii=False, indent=1))
        return 0
    if data.get("errors"):
        print("ERROR: " + json.dumps(data["errors"], ensure_ascii=False, indent=1))
        return 2
    print(json.dumps(data["data"]["runPluginOperation"], ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
