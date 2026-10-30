// 对比「演员弹窗」与「加入库」两次 box 查询的真实体积与耗时（2026-10-30）
(async function () {
  var d = await SSD.callGQL("query{configuration{general{stashBoxes{name endpoint api_key}}}}");
  var bs = (d.configuration.general.stashBoxes || []);
  var targets = [
    { name: "stashdb", id: "573e7c3e-799c-4a3a-b948-32b5b18c16f1" },
    { name: "javstash", id: "7ec0cb70-9667-4388-98d9-3c19bfe571f3" },
  ];
  var Q1 = "query($id:ID!){findPerformer(id:$id){id name gender birth_date country aliases images{url}}}";
  var Q2 = "query($id:ID!){findPerformer(id:$id){id name disambiguation aliases deleted gender country " +
    "birth_date death_date urls{url} images{url} height cup_size band_size waist_size hip_size " +
    "career_start_year career_end_year ethnicity hair_color eye_color " +
    "tattoos{location description} piercings{location description}}}";

  async function run(ep, key, id, q) {
    var t0 = performance.now();
    var r = await fetch(ep, {
      method: "POST",
      headers: { "Content-Type": "application/json", "ApiKey": key },
      body: JSON.stringify({ query: q, variables: { id: id } }),
    });
    var txt = await r.text();
    var o = null;
    try { o = JSON.parse(txt); } catch (e) {}
    return { ms: Math.round(performance.now() - t0), bytes: txt.length, status: r.status,
             ok: !!(o && o.data && o.data.findPerformer), body: txt.slice(0, 160) };
  }

  var out = [];
  for (var i = 0; i < targets.length; i++) {
    var b = bs.filter(function (x) { return x.name.indexOf(targets[i].name) >= 0; })[0];
    if (!b) { out.push({ name: targets[i].name, err: "not configured" }); continue; }
    var a = await run(b.endpoint, b.api_key, targets[i].id, Q1);
    var c = await run(b.endpoint, b.api_key, targets[i].id, Q2);
    out.push({ name: targets[i].name, popup: a, import: c });
  }
  return JSON.stringify(out);
})()
