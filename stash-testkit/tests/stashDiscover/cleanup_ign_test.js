(async () => {
  const raw = JSON.parse(localStorage.getItem("SSD:dp:ignore.v1") || "{}");
  raw.performers = raw.performers || {};
  raw.scenes = raw.scenes || {};
  const badP = Object.keys(raw.performers).filter(function (k) { return /test-ig|019e6962/.test(k); });
  const badS = Object.keys(raw.scenes).filter(function (k) { return /test-ig/.test(k); });
  badP.forEach(function (k) { delete raw.performers[k]; });
  badS.forEach(function (k) { delete raw.scenes[k]; });
  localStorage.setItem("SSD:dp:ignore.v1", JSON.stringify(raw));
  return JSON.stringify({ removedPerformers: badP.length, removedScenes: badS.length, left: { p: Object.keys(raw.performers).length, s: Object.keys(raw.scenes).length } });
})()
