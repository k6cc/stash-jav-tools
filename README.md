# stash-jav-tools

Stash 鎻掍欢宸ュ叿闆?鈥?Python + UI 娣峰悎鎻掍欢鍚堥泦銆?
## 鍖呭惈鎻掍欢

| 鎻掍欢 | 鐗堟湰 | 绫诲瀷 | 璇存槑 |
|------|------|------|------|
| [sceneTranslate](./sceneTranslate/) | 2.9.2 | Python + UI | 鍦烘櫙/鍥剧墖/鍥惧簱缂栬緫椤典竴閿炕璇戯紙Google/Microsoft/Baidu/DeepL/OpenAI锛孲tash UI 鍙厤缃級 |
| [sceneGallerySync](./sceneGallerySync/) | 1.9.1 | Python + UI | 鎵弿鍏ュ簱鏃惰嚜鍔ㄥ垱寤哄浘搴撳苟鍏宠仈褰辩墖 |
| [studioTools](./studioTools/) | 1.5.3 | 绾?UI | 宸ヤ綔瀹ゅ悎骞?+ 澶氭簮鎼滅储鏇存柊 StashDB/ThePornDB/JAVStash |
| [JavStashLinker](./JavStashLinker/) | 1.5.8 | Python + UI | 鎵归噺鍖归厤 JAVStash 婕斿憳 ID锛氬満鏅弽鎺?+ 鍚嶇О鎼滅储 + 鎵嬪姩鎼滅储锛堣瘉鎹瘎绾э紝鑷姩琛ュ浘琛ヤ俊鎭級 |
| [performerMerge](./performerMerge/) | 1.6.3 | 绾?UI | 閲嶅悕婕斿憳妫€娴嬩笌鍚堝苟锛堣瘉鎹垎绾ц繛缁?+ 鏍戠骇鍐茬獊妫€鏌ワ級锛岄檮甯︾煭鍚嶆竻鐞嗕笌鍒悕淇 |
| [tagMerge](./tagMerge/) | 2.5.1 | 绾?UI | 鎸夊彲缂栬緫鏄犲皠搴撳悎骞剁浉浼?tags 涓鸿鑼冧腑鏂?tag锛堟簮鍚嶄繚鐣欎负鍒悕锛屾槧灏勫彲缂栬緫瀵煎嚭锛?|
| [studioToolsAuto](./studioToolsAuto/) | 1.1.2 | 绾悗鍙?| 宸ヤ綔瀹ゅ垱寤烘椂鑷姩浠?Stash-box 瀹炰緥鎷夊彇璧勬枡锛屽綊涓€鍖栫簿纭尮閰嶅悗鍚堝苟/琛ュ叏锛堥浂 UI 娉ㄥ叆锛屽彲寮€澶氭簮琛ラ綈锛?|
| [tagMergeAuto](./tagMergeAuto/) | 1.1.0 | 绾悗鍙?| 閽╁瓙鑷姩鍚堝苟鏂板缓 tag + 浠诲姟椤靛叏閲忔壂鎻忥紙鏈湴鏄犲皠琛ㄣ€侀浂缃戠粶闆惰缃級 |
| [sceneTranslateAuto](./sceneTranslateAuto/) | 1.2.0 | 绾悗鍙?| 閽╁瓙鑷姩缈昏瘧鍦烘櫙鏍囬/绠€浠嬩负鐩爣璇█ + 浠诲姟椤靛叏閲忔壂鎻忥紙澶嶇敤 sceneTranslate 寮曟搸锛屾棤浠ｇ悊鏃犵鍙ｏ級 |
| [javstashAutofill+](./javstashAutofill+/) | 1.0.8 | 绾悗鍙?| 鏂版紨鍛樻寜鍚嶅埉鍓?JAVStash 琛ュ叏瀛楁+stash_id锛涙柊鍦烘櫙鎸?oshash 琛ョ┖鐧藉瓧娈?stash_id锛涙墜鍔ㄤ换鍔℃壒閲忓洖濉?|

## 瀹夎

### 鏂瑰紡涓€锛氶€氳繃 Stash 鎻掍欢婧愬畨瑁咃紙鎺ㄨ崘锛?
鍦?**Stash 鈫?璁剧疆 鈫?鎻掍欢 鈫?鍙敤鎻掍欢 鈫?娣诲姞婧?* 涓坊鍔狅細

```
https://k6cc.github.io/stash-plugins/plugins/main/index.yml
```

> 姝?URL 鏄粺涓€鎻掍欢婧愶紝鍖呭惈澶氫釜鎻掍欢锛屽彲涓€骞跺畨瑁呫€?
### 鏂瑰紡浜岋細鎵嬪姩瀹夎

浠?[Releases](https://github.com/k6cc/stash-jav-tools/releases) 涓嬭浇瀵瑰簲鎻掍欢鐨?zip锛岃В鍘嬪埌 Stash 鎻掍欢鐩綍锛?
- **Windows**: `%USERPROFILE%\.stash\plugins\`
- **Linux/macOS**: `~/.stash/plugins/`

姣忎釜 zip 鍐呮枃浠剁洿鎺ユ斁鍦ㄤ互鎻掍欢鍚嶅懡鍚嶇殑瀛愮洰褰曚笅锛?
```
plugins/
  sceneTranslate/      # 瑙ｅ帇 sceneTranslate-vX.Y.Z.zip
  sceneGallerySync/    # 瑙ｅ帇 sceneGallerySync-vX.Y.Z.zip
  studioTools/         # 瑙ｅ帇 studioTools-vX.Y.Z.zip
  JavStashLinker/      # 瑙ｅ帇 JavStashLinker-vX.Y.Z.zip
  performerMerge/      # 瑙ｅ帇 performerMerge-vX.Y.Z.zip
  tagMerge/            # 瑙ｅ帇 tagMerge-vX.Y.Z.zip
  studioToolsAuto/     # 瑙ｅ帇 studioToolsAuto-vX.Y.Z.zip
  tagMergeAuto/        # 瑙ｅ帇 tagMergeAuto-vX.Y.Z.zip
  sceneTranslateAuto/  # 瑙ｅ帇 sceneTranslateAuto-vX.Y.Z.zip
  javstashAutofill+/  # 瑙ｅ帇 javstashAutofill+-vX.Y.Z.zip
```

## 鍓嶇疆渚濊禆

| 鎻掍欢 | Python | requests | Stash-box API Key |
|------|--------|----------|-----------------|
| sceneTranslate | 闇€瑕?| 闇€瑕?| 涓嶉渶瑕?|
| sceneGallerySync | 闇€瑕?| 闇€瑕?| 涓嶉渶瑕?|
| studioTools | 涓嶉渶瑕?| 涓嶉渶瑕?| Search 妯″潡闇€瑕侊紙StashDB/ThePornDB/JAVStash 浠讳竴锛?|
| JavStashLinker | 闇€瑕?| 闇€瑕?| JAVStash锛堢粡銆岃缃?鈫?鍏冩暟鎹彁渚涜€呫€峴tash-box 绔偣閰嶇疆锛屾彃浠惰嚜鍔ㄥ鐢級 |
| performerMerge | 涓嶉渶瑕?| 涓嶉渶瑕?| 涓嶉渶瑕侊紙闇€ Stash v0.31.0+锛?|
| tagMerge | 涓嶉渶瑕?| 涓嶉渶瑕?| 涓嶉渶瑕侊紙闇€ Stash v0.30+锛?|
| studioToolsAuto | 闇€瑕?| 涓嶉渶瑕?| 闇€瑕侊紙缁忋€岃缃?鈫?鍏冩暟鎹彁渚涜€呫€嶉厤缃?Stash-box 瀹炰緥锛屾彃浠惰嚜鍔ㄥ鐢級 |
| tagMergeAuto | 闇€瑕?| 涓嶉渶瑕?| 涓嶉渶瑕?|
| sceneTranslateAuto | 闇€瑕?| 涓嶉渶瑕?| 涓嶉渶瑕侊紙闇€瀹瑰櫒/瀹夸富鏈哄彲璁块棶缈昏瘧 API 澶栫綉锛?|
| javstashAutofill+ | 闇€瑕?| 涓嶉渶瑕?| JAVStash锛堢粡銆岃缃?鈫?鍏冩暟鎹彁渚涜€呫€峴tash-box 绔偣閰嶇疆锛屾彃浠惰嚜鍔ㄥ鐢級 |

### Docker 閮ㄧ讲

Stash 瀹樻柟闀滃儚宸查瑁?Python 鍜?requests锛屾棤闇€棰濆鎿嶄綔銆俿tudioTools銆乸erformerMerge 鍜?tagMerge 鏄函 UI 鎻掍欢锛宻tudioToolsAuto / tagMergeAuto / sceneTranslateAuto / javstashAutofill+ 鏄函鍚庡彴鎻掍欢锛堟爣鍑嗗簱 only锛夛紝Docker 鍜岃８鏈哄潎鍙洿鎺ヤ娇鐢ㄣ€俿ceneTranslateAuto 鏃犱唬鐞嗘棤绔彛锛孌ocker 鏃犻渶鏄犲皠棰濆绔彛锛堜粎闇€瀹瑰櫒鍙闂炕璇?API 澶栫綉锛夈€?
### Windows / macOS 瑁告満閮ㄧ讲锛堜粎 Python 鎻掍欢锛?
楠岃瘉 `python --version` 涓?`python -c "import requests"`锛涚己澶辨椂鎸夐『搴忓畨瑁咃細

```powershell
# Windows锛坵inget锛?winget install Python.Python.3.12
pip install requests

# macOS锛坔omebrew锛?brew install python@3.12
pip3 install requests
```

## 瑙﹀彂鏂瑰紡

| 鎻掍欢 | 绫诲瀷 | 瑙﹀彂鏂瑰紡 |
|------|------|---------|
| sceneTranslate | Python + UI | 鎵嬪姩浠诲姟 + 鍦烘櫙/鍥剧墖缂栬緫椤垫寜閽?|
| sceneGallerySync | Python + UI | Scene.Update.Post 閽╁瓙 + 鎵嬪姩鎸夐挳 |
| studioTools | 绾?UI | 宸ヤ綔瀹よ鎯呴〉鎸夐挳 |
| JavStashLinker | Python + UI | 瀵艰埅鏍忔寜閽?+ 鎵嬪姩浠诲姟 |
| performerMerge | 绾?UI | 瀵艰埅鏍忔寜閽?|
| tagMerge | 绾?UI | 瀵艰埅鏍忔寜閽?|
| studioToolsAuto | 绾悗鍙?| Studio.Create.Post 閽╁瓙 + 鎵嬪姩浠诲姟 |
| tagMergeAuto | 绾悗鍙?| Tag.Create.Post 閽╁瓙 + 鎵嬪姩浠诲姟 |
| sceneTranslateAuto | 绾悗鍙?| Scene.Create.Post / Scene.Update.Post 閽╁瓙 + 鎵嬪姩浠诲姟 |
| javstashAutofill+ | 绾悗鍙?| Performer.Create.Post / Scene.Create.Post 閽╁瓙 + 鎵嬪姩浠诲姟 |

鍚勬彃浠惰缁嗕娇鐢ㄨ鏄庤瀵瑰簲鐩綍涓嬬殑 `README.md`銆?
## License

MIT
