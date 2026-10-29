(async () => {
  // 造几条已忽略记录，覆盖：国旗/年龄/性别齐全、只有别名、什么都没有
  const s = (ms) => new Promise((r) => setTimeout(r, ms));
  await s(600);
  const raw = JSON.parse(localStorage.getItem("SSD:dp:ignore.v1") || "{}");
  raw.scenes = raw.scenes || {};
  raw.performers = raw.performers || {};
  const now = Date.now();
  raw.performers["https://stashdb.org/graphql:019e6962-1f2a-70db-afbb-269fe47972a6"] = {
    at: now, name: "風吹ケイ", image: "", country: "JP", birthdate: "1999-04-05", gender: "FEMALE",
  };
  raw.performers["stashdb:test-ig-a"] = {
    at: now - 1000, name: "SSD 测试演员甲甲", image: "", country: "US", birthdate: "1990-02-03", gender: "FEMALE",
  };
  raw.performers["javstash:test-ig-b"] = {
    at: now - 2000, name: "SSD 测试演员乙乙", image: "", country: "KR", gender: "MALE",
  };
  raw.performers["theporndb:test-ig-c"] = {
    at: now - 3000, name: "SSD 测试演员丙丙", image: "", country: "TH", gender: "TRANSGENDER_FEMALE",
  };
  raw.performers["stashdb:test-ig-d"] = {
    at: now - 4000, name: "SSD 测试演员丁丁", image: "", alias_list: ["SSD alias one", "SSD alias two"],
  };
  raw.scenes["stashdb:test-ig-s1"] = {
    at: now - 500, title: "SSD 测试场景一", code: "SSD-001", studio: "TestStudio",
    date: "2026-10-01", cover: "", p: ["風吹ケイ", "SSD 测试演员甲甲"],
  };
  localStorage.setItem("SSD:dp:ignore.v1", JSON.stringify(raw));
  return "seeded " + Object.keys(raw.performers).length + " performers";
})()
