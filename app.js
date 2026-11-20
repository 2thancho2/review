import { SUPABASE_URL, SUPABASE_ANON_KEY, STUDENT_EMAIL_DOMAIN, VAPID_PUBLIC_KEY } from "./supabase-config.js";
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.97.0/+esm";

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const JSPDF_URL = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";
const H2C_URL = "https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js";
const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite";

const root = document.getElementById("app");
const navEl = document.getElementById("nav");
const footEl = document.getElementById("foot");
const bannerEl = document.getElementById("banner");
let user = null;
let isAdmin = false;
let timers = [];
let unread = 0;
let chan = null;
let pushOn = false;

// 제출별 제미나이 코멘트 캐시 (key: `${postId}:${userId}`)
const aiCommentCache = new Map();

/* ---------- 스플래시 인트로 제어 ---------- */
function initSplash() {
  const splash = document.getElementById("splash");
  if (!splash) return;
  setTimeout(() => {
    splash.classList.add("done");
    setTimeout(() => splash.remove(), 650);
  }, 2400);
}
initSplash();

/* ---------- 유틸 ---------- */
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, v);
  }
  for (const k of kids.flat()) {
    if (k == null || k === false) continue;
    el.append(k.nodeType ? k : document.createTextNode(k));
  }
  return el;
}
const render = (...nodes) => root.replaceChildren(...nodes);
const card = (...kids) => h("div", { class: "card" }, ...kids);
const clearTimers = () => { timers.forEach(clearInterval); timers = []; };
const must = (res) => { if (res.error) throw res.error; return res.data; };

function toast(msg) {
  const t = h("div", { class: "toast" }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 3500);
}
function friendly(e) {
  const m = (e && (e.message || e.code)) || String(e);
  if (/row-level security|permission denied|not authorized|Unauthorized/i.test(m)) return "권한이 없거나 마감 시간이 지났어요.";
  if (/Invalid login credentials/i.test(m)) return "아이디(이메일) 또는 비밀번호가 올바르지 않아요.";
  if (/mime|not supported|invalid.*type/i.test(m)) return "사진(JPG)만 올릴 수 있어요. (영상은 mp4/mov/webm)";
  if (/Failed to fetch|NetworkError/i.test(m)) return "서버에 연결하지 못했어요. 인터넷 연결을 확인하세요.";
  if (/exceeded the maximum allowed size|too large/i.test(m)) return "파일이 너무 커요. (영상은 50MB 이하)";
  return m;
}
async function run(btn, fn) {
  if (btn) btn.disabled = true;
  try { return await fn(); }
  catch (e) { console.error(e); toast(friendly(e)); }
  finally { if (btn) btn.disabled = false; }
}

const fmt = (s) => s
  ? new Date(s).toLocaleString("ko-KR", { month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" })
  : "";
const fmtFull = (s) => new Date(s).toLocaleString("ko-KR", { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const ms = (s) => new Date(s).getTime();
const toLocalInput = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
const byName = (a, b) => (a.name || "").localeCompare(b.name || "", "ko");
const genCode = () => Array.from(crypto.getRandomValues(new Uint8Array(6)),
  (n) => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[n % 32]).join("");

function safeUrl(u) {
  try {
    const x = new URL(u.trim());
    return x.protocol === "http:" || x.protocol === "https:" ? x.href : null;
  } catch { return null; }
}
function ytId(u) {
  const m = (u || "").trim().match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/))([\w-]{11})/);
  return m ? m[1] : null;
}
async function compressImage(file, max = 1600, q = 0.82) {
  if (!file.type.startsWith("image/")) throw new Error("이미지 파일만 올릴 수 있어요.");
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * s);
  c.height = Math.round(bmp.height * s);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("이미지 변환 실패"))), "image/jpeg", q));
}
function openLightbox(url) {
  const o = h("div", { class: "lightbox", onclick: () => o.remove() }, h("img", { src: url }));
  document.body.append(o);
}
const photoGrid = (photos) =>
  h("div", { class: "photos" }, (photos || []).map((p) =>
    h("img", { src: p.url, loading: "lazy", alt: "제출 사진", onclick: () => openLightbox(p.url) })));
const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
const safeName = (s) => String(s).replace(/[\\/:*?"<>|]/g, "_").slice(0, 40);

/* ---------- 제미나이 숙제 분석 (DB 설정 저장/조회) ---------- */
async function loadAiSettingsFromDb() {
  const { data, error } = await sb
    .from("ai_settings")
    .select("gemini_api_key,gemini_model")
    .eq("id", "default")
    .maybeSingle();
  if (error) throw error;
  return {
    apiKey: (data?.gemini_api_key || "").trim(),
    model: (data?.gemini_model || DEFAULT_GEMINI_MODEL).trim(),
  };
}

async function saveAiSettingsToDb({ apiKey, model }) {
  const payload = {
    id: "default",
    gemini_api_key: (apiKey || "").trim() || null,
    gemini_model: (model || DEFAULT_GEMINI_MODEL).trim(),
    updated_at: new Date().toISOString(),
  };
  const { error } = await sb.from("ai_settings").upsert(payload, { onConflict: "id" });
  if (error) throw error;
}

function aiQuotaNoticeEl() {
  return h("div", { class: "notice-box" },
    h("strong", {}, "제미나이 API 한도 및 정확도 안내"),
    h("p", { style: "margin:6px 0 4px" },
      "Gemini API 무료 티어(Free Tier)는 프로젝트 및 모델별로 하루 요청 수(RPD)와 분당 요청 수(RPM)가 제한됩니다. 일부 Flash 모델은 일일 요청 한도가 매우 적을 수 있고(예: 일일 20회 수준), Flash-Lite 계열은 상대적으로 더 많은 일일 요청이 허용될 수 있으나 정확한 수치는 Google AI Studio 프로젝트 한도 화면에서 확인해야 합니다."),
    h("p", { style: "margin:0 0 4px" },
      "학생 1명의 제출물(여러 장의 사진 포함)을 1회 분석하는 기준으로 설정하면, 일일 요청 한도가 N회일 때 하루 최대 N명 안팎의 과제를 검사할 수 있습니다. (예: 하루 20회 한도라면 최대 약 20명, 하루 500회 한도라면 최대 약 500명)"),
    h("p", { style: "margin:0" },
      "※ AI 이미지 판독은 손글씨 흐림, 조명/각도, 사진 일부 잘림, 복잡한 수식·도형 등에 따라 정확하지 않을 수 있습니다. 최종 채점과 확인은 반드시 선생님이 직접 검토해 주세요."));
}

async function imageUrlToBase64(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("제출 이미지를 불러오지 못했어요.");
  const blob = await res.blob();
  const mimeType = blob.type || "image/jpeg";
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("이미지 인코딩에 실패했어요."));
    reader.readAsDataURL(blob);
  });
  const base64 = String(dataUrl).split(",")[1] || "";
  return { mimeType, base64 };
}

async function analyzeSubmissionWithGemini({ post, studentName, photos }) {
  const { apiKey, model } = await loadAiSettingsFromDb();
  if (!apiKey) throw new Error("먼저 [AI 설정]에서 제미나이 API 키를 입력해 주세요.");
  if (!photos || !photos.length) return "제출된 사진이 없어 AI 검사를 진행할 수 없어요.";

  const criteria = (post.ai_criteria || post.criteria || "").trim() || "과제 제목과 내용에 맞게 성실히 작성했는지 확인";
  const parts = [];

  for (const p of photos.slice(0, 6)) {
    if (!p.url) continue;
    const { mimeType, base64 } = await imageUrlToBase64(p.url);
    parts.push({ inlineData: { mimeType, data: base64 } });
  }
  if (!parts.length) throw new Error("분석할 수 있는 이미지 URL이 없어요.");

  const prompt = [
    "당신은 한국 교사의 숙제 검토를 돕는 AI 보조자입니다.",
    `과제 제목: ${post.title}`,
    post.body ? `과제 설명: ${post.body}` : "",
    `선생님이 정한 AI 검사 기준: ${criteria}`,
    `학생 이름: ${studentName}`,
    "",
    "첨부된 학생 제출 이미지를 보고 아래 형식으로 간결하고 명확한 한국어 코멘트를 작성하세요.",
    "1) 기준 부합 여부: [충족 / 일부 부족 / 미흡] 중 하나와 한 줄 요약",
    "2) 잘한 점: 1~2문장",
    "3) 부족한 점 / 보완할 점: 1~2문장 (없으면 '특별히 부족한 점 없음'으로 표기)",
    "※ AI 판독이므로 오차가 있을 수 있음을 전제로 객관적으로 작성하세요.",
  ].filter(Boolean).join("\n");

  parts.push({ text: prompt });

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const resp = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts }],
    }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(data?.error?.message || `제미나이 API 오류 (${resp.status})`);
  }
  const text = data?.candidates?.[0]?.content?.parts
    ?.map((pt) => pt.text || "")
    .join("")
    .trim();
  if (!text) throw new Error("제미나이에서 코멘트 응답을 받지 못했어요.");
  return text;
}

/* ---------- 파일(비공개 버킷) ---------- */
async function uploadFile(bucket, blob, path, contentType) {
  const { error } = await sb.storage.from(bucket).upload(path, blob, { contentType, upsert: false });
  if (error) throw error;
  return { path };
}
async function signMap(bucket, paths) {
  const map = new Map();
  const uniq = [...new Set(paths)];
  for (let i = 0; i < uniq.length; i += 100) {
    const part = uniq.slice(i, i + 100);
    const { data, error } = await sb.storage.from(bucket).createSignedUrls(part, 3600);
    if (error) throw error;
    data.forEach((d, j) => { if (d.signedUrl) map.set(part[j], d.signedUrl); });
  }
  return map;
}
const withUrls = (items, map) => (items || []).map((it) => ({ ...it, url: map.get(it.path) || "" }));
async function resolvePost(p) {
  const map = await signMap("post-media", [...(p.images || []), ...(p.videos || [])].map((x) => x.path));
  return { ...p, images: withUrls(p.images, map), videos: withUrls(p.videos, map) };
}
async function removeFiles(bucket, paths) {
  for (let i = 0; i < paths.length; i += 100) {
    const { error } = await sb.storage.from(bucket).remove(paths.slice(i, i + 100));
    if (error) throw error;
  }
}

function rowsEditor(placeholders, addLabel) {
  const list = h("div");
  const add = () => {
    const inputs = placeholders.map((p) => h("input", { type: "text", placeholder: p }));
    const row = h("div", { class: "row" }, ...inputs,
      h("button", { type: "button", class: "btn ghost sm", onclick: () => row.remove() }, "✕"));
    row._inputs = inputs;
    list.append(row);
  };
  const el = h("div", {}, list, h("button", { type: "button", class: "btn ghost sm", onclick: add }, addLabel));
  return {
    el,
    values: () => [...list.children].map((r) => r._inputs.map((i) => i.value.trim())).filter((v) => v.some(Boolean)),
  };
}

function postContent(p) {
  const box = h("div", { class: "post-content" });
  if (p.body) box.append(h("div", { class: "body" }, p.body));
  if (p.ai_criteria) {
    box.append(h("div", { class: "ai-box" },
      h("div", { class: "ai-box-title" }, "AI 검사 기준"),
      h("div", {}, p.ai_criteria)));
  }
  (p.youtube || []).forEach((id) => box.append(h("div", { class: "yt" },
    h("iframe", {
      src: `https://www.youtube-nocookie.com/embed/${id}`, title: "YouTube", loading: "lazy",
      allow: "accelerometer; encrypted-media; picture-in-picture", allowfullscreen: true,
    }))));
  (p.videos || []).forEach((v) => box.append(h("video", { src: v.url, controls: true, preload: "metadata", playsinline: true })));
  if ((p.images || []).length) box.append(photoGrid(p.images));
  if ((p.links || []).length) {
    box.append(h("div", { class: "links" }, p.links.map((l) =>
      h("a", { href: l.url, target: "_blank", rel: "noopener noreferrer" }, "🔗 " + (l.label || l.url)))));
  }
  return box;
}

/* ---------- 푸시 알림 (브라우저 Web Push) ---------- */
const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
const isStandalone = () => window.navigator.standalone === true || window.matchMedia("(display-mode: standalone)").matches;
function b64ToU8(b64) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
async function currentPushSub() {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}
async function refreshPushState() {
  try { pushOn = !!(await currentPushSub()) && Notification.permission === "granted"; } catch { pushOn = false; }
}
async function enablePush() {
  if (!pushSupported()) {
    throw new Error(isIOS() ? "아이폰은 공유 버튼 → '홈 화면에 추가'로 앱을 설치한 뒤, 그 앱에서 켜 주세요." : "이 브라우저는 푸시 알림을 지원하지 않아요.");
  }
  if (isIOS() && !isStandalone()) throw new Error("아이폰은 공유 버튼 → '홈 화면에 추가'로 앱을 설치한 뒤, 그 앱에서 켜 주세요.");
  if (!VAPID_PUBLIC_KEY || VAPID_PUBLIC_KEY.startsWith("YOUR_")) throw new Error("supabase-config.js에 VAPID_PUBLIC_KEY를 입력해야 해요.");
  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw new Error("알림 권한이 허용되지 않았어요. 브라우저 설정에서 허용해 주세요.");
  const reg = await navigator.serviceWorker.register("sw.js");
  await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription())
    || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(VAPID_PUBLIC_KEY) }));
  const j = sub.toJSON();
  must(await sb.rpc("register_push", { p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth, p_ua: navigator.userAgent }));
  pushOn = true;
}
async function disablePush() {
  const sub = await currentPushSub();
  if (sub) {
    await sb.rpc("unregister_push", { p_endpoint: sub.endpoint });
    await sub.unsubscribe();
  }
  pushOn = false;
}

/* ---------- 인증 ---------- */
const FN_URL = SUPABASE_URL + "/functions/v1/worker";
const toEmail = (id) => `${String(id).trim().toLowerCase()}@${STUDENT_EMAIL_DOMAIN}`;

async function callWorker(action, body, withAuth) {
  const headers = { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY };
  if (withAuth) {
    const { data } = await sb.auth.getSession();
    headers.Authorization = "Bearer " + (data.session?.access_token || "");
  }
  const r = await fetch(`${FN_URL}?action=${action}`, { method: "POST", headers, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || "요청에 실패했어요. (" + r.status + ")");
  return j;
}

sb.auth.onAuthStateChange((evt, session) => {
  setTimeout(async () => {
    try {
      if (!session) {
        user = null; isAdmin = false; pushOn = false; unread = 0;
        if (chan) { sb.removeChannel(chan); chan = null; }
        bannerEl.replaceChildren();
        renderNav();
        viewLogin();
        return;
      }
      if (user && user.id === session.user.id) return;
      await setUser(session.user);
    } catch (e) {
      console.error(e);
      render(card(h("h2", {}, "연결 오류"),
        h("p", {}, "supabase-config.js 의 주소/키 값을 확인해 주세요."),
        h("p", { class: "muted" }, friendly(e))));
    }
  }, 0);
});

async function setUser(u) {
  user = u;
  const { data } = await sb.from("admins").select("user_id").maybeSingle();
  isAdmin = !!data;
  sb.rpc("touch_activity").then(() => {}, () => {});
  await refreshPushState();
  await refreshUnread().catch(() => {});
  startRealtime();
  route();
}

async function doLogout() {
  try { await disablePush(); } catch { /* 무시 */ }
  location.hash = "#/";
  await sb.auth.signOut();
}

/* ---------- 알림 (앱 안) ---------- */
async function refreshUnread() {
  const { count } = await sb.from("notifications").select("id", { count: "exact", head: true }).is("read_at", null);
  unread = count || 0;
  paintBadge();
}
function paintBadge() {
  const el = document.getElementById("bell-count");
  if (!el) return;
  el.textContent = unread > 99 ? "99+" : String(unread);
  el.style.display = unread ? "flex" : "none";
}
function startRealtime() {
  if (chan) sb.removeChannel(chan);
  chan = sb.channel("notif-" + user.id)
    .on("postgres_changes",
      { event: "INSERT", schema: "public", table: "notifications", filter: `user_id=eq.${user.id}` },
      (payload) => {
        const n = payload.new;
        unread++;
        paintBadge();
        toast("🔔 " + n.title);
        if (!pushOn && "Notification" in window && Notification.permission === "granted" && document.hidden) {
          try { new Notification(n.title, { body: n.body }); } catch { /* 무시 */ }
        }
        if (location.hash.startsWith("#/notifications")) route();
      })
    .subscribe();
}

async function viewNotifications() {
  const rows = must(await sb.from("notifications").select("*").order("created_at", { ascending: false }).limit(50));

  let pushCard;
  if (!pushSupported() || (isIOS() && !isStandalone())) {
    pushCard = card(h("h3", {}, "푸시 알림"),
      h("p", { class: "muted" }, isIOS()
        ? "아이폰/아이패드는 사파리 공유 버튼 → '홈 화면에 추가'로 앱을 설치한 뒤, 그 앱에서 알림을 켜면 받을 수 있어요. (iOS 16.4 이상)"
        : "이 브라우저는 푸시 알림을 지원하지 않아요. 크롬/엣지/삼성인터넷/파이어폭스 최신 버전을 쓰세요."));
  } else {
    pushCard = card(h("h3", {}, "푸시 알림"),
      h("p", { class: "muted" }, pushOn ? "이 기기에서 푸시 알림이 켜져 있어요. 새 과제, 마감 임박 등을 알려드려요." : "켜면 앱을 닫아 둬도 새 과제·마감 임박 알림이 와요."),
      h("div", { class: "actions", style: "margin-top:0" },
        pushOn
          ? h("button", { class: "btn ghost sm", onclick: (e) => run(e.currentTarget, async () => { await disablePush(); toast("이 기기의 푸시 알림을 껐어요."); route(); }) }, "푸시 알림 끄기")
          : h("button", { class: "btn sm", onclick: (e) => run(e.currentTarget, async () => { await enablePush(); toast("푸시 알림을 켰어요."); route(); }) }, "푸시 알림 켜기")));
  }

  render(
    pushCard,
    card(h("h2", {}, "알림"),
      h("div", { class: "actions", style: "margin-top:0" },
        h("button", {
          class: "btn ghost sm",
          onclick: (e) => run(e.currentTarget, async () => {
            must(await sb.from("notifications").update({ read_at: new Date().toISOString() }).is("read_at", null));
            await refreshUnread(); route();
          }),
        }, "모두 읽음")),
      h("p", { class: "muted" }, "알림은 30일 뒤 자동 정리돼요.")),
    card(rows.length ? rows.map((n) => h("a", {
      class: "notif" + (n.read_at ? "" : " unread"), href: n.link || "#/notifications",
      onclick: () => {
        if (!n.read_at) sb.from("notifications").update({ read_at: new Date().toISOString() }).eq("id", n.id).then(() => refreshUnread());
      },
    }, h("div", { class: "t" }, n.title), n.body ? h("div", { class: "muted" }, n.body) : null,
    h("div", { class: "muted" }, fmt(n.created_at)))) : h("p", { class: "muted" }, "알림이 없어요.")));
}

/* ---------- 라우팅 ---------- */
window.addEventListener("hashchange", route);

function renderNav() {
  const bell = h("a", { class: "bell", href: "#/notifications", title: "알림" }, "알림",
    h("span", { class: "count", id: "bell-count", style: "display:none" }, "0"));
  const links = [];
  if (isAdmin) {
    links.push(
      h("a", { href: "#/admin" }, "클래스"),
      h("a", { href: "#/admin/posts" }, "포스트"),
      h("a", { href: "#/admin/new" }, "새 포스트"),
      h("a", { href: "#/admin/ai" }, "AI 설정"),
      bell,
      h("button", { class: "link", onclick: doLogout }, "로그아웃")
    );
  } else {
    links.push(h("a", { href: "#/" }, "내 클래스"), bell, h("a", { href: "#/account" }, "내 계정"));
  }
  navEl.replaceChildren(h("a", { class: "brand", href: isAdmin ? "#/admin" : "#/" }, "복습해라"), ...(user ? links : []));
  footEl.replaceChildren(user ? "" : h("a", { href: "#/admin" }, "선생님 로그인"));
  paintBadge();
}

async function route() {
  if (!user) { renderNav(); return viewLogin(); }
  clearTimers();
  renderNav();
  updateBanner().catch((e) => console.error(e));
  const parts = (location.hash || "#/").slice(2).split("/").filter(Boolean);
  try {
    if (parts[0] === "notifications") return await viewNotifications();
    if (parts[0] === "account" && !isAdmin) return viewAccount();
    if (parts[0] === "admin") {
      if (!isAdmin) return viewAdminLogin();
      if (parts[1] === "ai") return await viewAdminAiSettings();
      if (parts[1] === "posts") return await viewAdminPosts();
      if (parts[1] === "new") return await viewAdminNew();
      if (parts[1] === "post") return await viewAdminPost(parts[2], parts[3]);
      return await viewAdminClasses();
    }
    if (isAdmin) { location.hash = "#/admin"; return; }
    if (parts[0] === "c" && parts[1]) {
      if (parts[2] === "p" && parts[3]) return await viewStudentPost(parts[1], parts[3]);
      return await viewStudentClass(parts[1]);
    }
    return await viewStudentHome();
  } catch (e) {
    console.error(e);
    render(h("div", { class: "card error" }, "오류: " + friendly(e)));
  }
}

/* ---------- 관리자: 제미나이 API 설정 (DB 저장) ---------- */
async function viewAdminAiSettings() {
  let current = { apiKey: "", model: DEFAULT_GEMINI_MODEL };
  let loadError = "";

  try {
    current = await loadAiSettingsFromDb();
  } catch (e) {
    loadError = friendly(e);
  }

  const keyIn = h("input", {
    type: "password",
    placeholder: "AIza...",
    value: current.apiKey,
    autocomplete: "off",
  });
  const modelSel = h("select", {},
    h("option", { value: "gemini-3.5-flash-lite", selected: current.model === "gemini-3.5-flash-lite" }, "gemini-3.5-flash-lite (빠름 / 권장)"),
    h("option", { value: "gemini-3.5-flash", selected: current.model === "gemini-3.5-flash" }, "gemini-3.5-flash (정밀 분석)")
  );

  const form = h("form", {
    onsubmit: (e) => {
      e.preventDefault();
      run(e.submitter, async () => {
        await saveAiSettingsToDb({ apiKey: keyIn.value, model: modelSel.value });
        toast("제미나이 설정을 데이터베이스에 저장했어요.");
      });
    },
  },
    loadError ? h("div", { class: "card error", style: "margin-bottom:12px" }, "DB 설정 불러오기 오류: " + loadError) : null,
    h("label", {}, "Gemini API 키"),
    keyIn,
    h("label", {}, "사용 모델"),
    modelSel,
    h("div", { class: "actions" },
      h("button", { class: "btn" }, "DB에 저장"),
      h("button", {
        type: "button",
        class: "btn ghost",
        onclick: (e) => run(e.currentTarget, async () => {
          keyIn.value = "";
          await saveAiSettingsToDb({ apiKey: "", model: modelSel.value });
          toast("DB에서 API 키를 지웠어요.");
        }),
      }, "키 삭제")),
    aiQuotaNoticeEl()
  );

  render(card(h("h2", {}, "제미나이 숙제 분석 설정"), form));
}

/* ---------- PDF 저장 후 삭제 ---------- */
function loadScript(src) {
  if (document.querySelector(`script[src="${src}"]`)) return Promise.resolve();
  return new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = src; s.onload = res;
    s.onerror = () => rej(new Error("PDF 라이브러리를 불러오지 못했어요. 인터넷 연결을 확인하세요."));
    document.head.append(s);
  });
}

async function exportPostPdf(post) {
  await loadScript(JSPDF_URL);
  await loadScript(H2C_URL);
  const [members, subs] = await Promise.all([
    sb.from("memberships").select("user_id,name").eq("class_id", post.class_id).eq("status", "approved").then(must),
    sb.from("submissions").select("*").eq("post_id", post.id).then(must),
  ]);
  subs.sort(byName);
  const done = new Set(subs.map((s) => s.user_id));
  const missing = members.filter((m) => !done.has(m.user_id)).sort(byName);
  const urlMap = await signMap("submissions", subs.flatMap((s) => (s.photos || []).map((x) => x.path)));
  const className = post.classes?.name || "";

  const wrap = (...kids) => h("div", { class: "pdf-page" }, ...kids);
  const pages = [];
  pages.push(wrap(
    h("h1", {}, post.title),
    h("div", {}, `${className} · 마감 ${fmtFull(post.deadline)}`),
    h("div", { style: "color:#555" }, `PDF 저장 일시 ${fmtFull(new Date().toISOString())}`),
    post.ai_criteria ? h("div", { class: "pdf-ai" }, `AI 검사 기준: ${post.ai_criteria}`) : null,
    h("h2", {}, `제출 현황 ${subs.length} / ${members.length}명`),
    h("h2", {}, `미제출 (${missing.length}명)`),
    h("div", {}, missing.length ? missing.map((m) => m.name).join(", ") : "없음")));
  chunk(subs, 30).forEach((rows, i) => pages.push(wrap(
    h("h2", {}, `제출자 목록 (${i + 1})`),
    h("table", {},
      h("tr", {}, h("th", {}, "이름"), h("th", {}, "제출 시각"), h("th", {}, "사진 수")),
      rows.map((s) => h("tr", {}, h("td", {}, s.name), h("td", {}, fmtFull(s.submitted_at)), h("td", {}, String((s.photos || []).length))))))));
  for (const s of subs) {
    const photos = s.photos || [];
    const rows = Math.max(1, Math.ceil(photos.length / 2));
    const imgH = Math.min(460, Math.floor(760 / rows) - 10);
    const aiText = aiCommentCache.get(`${post.id}:${s.user_id}`) || s.ai_comment || "AI 코멘트 미생성 (제출 상세 화면에서 '제미나이 검사' 실행 시 포함)";
    pages.push(wrap(
      h("h2", {}, `${s.name}  ·  ${fmtFull(s.submitted_at)}`),
      photos.length
        ? h("div", { class: "grid2" }, photos.map((p) =>
          h("img", { src: urlMap.get(p.path) || "", crossorigin: "anonymous", style: `height:${imgH}px` })))
        : h("div", {}, "사진 없음"),
      h("div", { class: "pdf-ai" }, `제미나이 코멘트:\n${aiText}`)));
  }

  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF({ unit: "mm", format: "a4" });
  for (let i = 0; i < pages.length; i++) {
    const el = pages[i];
    document.body.append(el);
    try {
      const imgs = [...el.querySelectorAll("img")];
      await Promise.all(imgs.map((img) => (img.complete ? Promise.resolve() : new Promise((r) => { img.onload = img.onerror = r; }))));
      if (imgs.some((img) => !img.naturalWidth)) {
        throw new Error("사진을 불러오지 못해 PDF 저장을 중단했어요.");
      }
      const canvas = await window.html2canvas(el, { scale: 1.3, useCORS: true, backgroundColor: "#ffffff" });
      if (i) pdf.addPage();
      pdf.addImage(canvas.toDataURL("image/jpeg", 0.82), "JPEG", 0, 0, 210, 297);
    } finally { el.remove(); }
  }
  pdf.save(`${safeName(className)}_${safeName(post.title)}_${new Date().toISOString().slice(0, 10)}.pdf`);
  await sb.from("posts").update({ exported_at: new Date().toISOString() }).eq("id", post.id);
}

async function purgePost(p) {
  const subs = must(await sb.from("submissions").select("photos").eq("post_id", p.id));
  await removeFiles("submissions", subs.flatMap((s) => (s.photos || []).map((x) => x.path)));
  must(await sb.from("posts").delete().eq("id", p.id));
  const { count } = await sb.from("posts").select("id", { count: "exact", head: true }).eq("group_id", p.group_id);
  if (!count) await removeFiles("post-media", [...(p.images || []), ...(p.videos || [])].map((x) => x.path));
}

async function exportAndPurge(list) {
  let ok = 0;
  for (const p of list) {
    toast(`PDF 만드는 중: ${p.title}`);
    await exportPostPdf(p);
    await purgePost(p);
    ok++;
  }
  toast(`${ok}개 과제를 PDF로 저장하고 삭제했어요.`);
  location.hash = isAdmin ? "#/admin/posts" : "#/";
  route();
}

async function updateBanner() {
  if (!isAdmin) { bannerEl.replaceChildren(); return; }
  const list = must(await sb.from("posts").select("*, classes(name)").lte("expires_at", new Date().toISOString()));
  if (!list.length) { bannerEl.replaceChildren(); return; }
  const noPdf = list.filter((p) => !p.exported_at).length;
  bannerEl.replaceChildren(h("div", { class: "warn-bar" },
    h("span", {}, `보관 기간이 끝난 과제 ${list.length}개가 곧 서버에서 자동 삭제돼요.` + (noPdf ? ` PDF를 저장하지 않은 ${noPdf}개는 PDF 없이 삭제되니 지금 저장하세요.` : " 모두 PDF가 저장돼 있어요.")),
    h("button", { class: "btn", onclick: (e) => run(e.currentTarget, () => exportAndPurge(list)) }, "PDF 저장 후 삭제")));
}

/* ---------- 학생: 로그인 / 계정 만들기 ---------- */
function viewLogin() {
  const hash = location.hash || "#/";
  if (hash.startsWith("#/admin")) return viewAdminLogin();
  let mode = "login";
  const box = h("div");
  const paint = () => {
    const id = h("input", { required: true, maxlength: 20, autocomplete: "username", autocapitalize: "none",
      placeholder: "영문 소문자·숫자 4~20자", pattern: "[A-Za-z0-9]{4,20}" });
    const pw = h("input", { type: "password", required: true, minlength: 8, maxlength: 72,
      autocomplete: mode === "login" ? "current-password" : "new-password", placeholder: "8자 이상" });
    const pw2 = mode === "signup" ? h("input", { type: "password", required: true, minlength: 8, maxlength: 72, autocomplete: "new-password" }) : null;
    const form = h("form", {
      onsubmit: (e) => {
        e.preventDefault();
        run(e.submitter, async () => {
          const lid = id.value.trim().toLowerCase();
          if (mode === "signup") {
            if (pw.value !== pw2.value) throw new Error("비밀번호가 서로 달라요.");
            await callWorker("signup_student", { login_id: lid, password: pw.value }, false);
          }
          const { error } = await sb.auth.signInWithPassword({ email: toEmail(lid), password: pw.value });
          if (error) throw error;
        });
      },
    }, h("label", {}, "아이디"), id, h("label", {}, "비밀번호"), pw,
    pw2 ? [h("label", {}, "비밀번호 확인"), pw2] : null,
    h("div", { class: "actions" }, h("button", { class: "btn" }, mode === "login" ? "로그인" : "계정 만들기")));
    box.replaceChildren(
      h("h2", {}, mode === "login" ? "학생 로그인" : "학생 계정 만들기"), form,
      mode === "login"
        ? h("p", { class: "muted" }, "처음이에요? ", h("button", { type: "button", class: "link", onclick: () => { mode = "signup"; paint(); } }, "계정 만들기"))
        : h("p", { class: "muted" }, "이미 계정이 있어요 ", h("button", { type: "button", class: "link", onclick: () => { mode = "login"; paint(); } }, "로그인")),
      h("p", { class: "muted" }, "로그인한 뒤에 선생님이 알려준 클래스 코드를 입력해서 참여 신청해요. 3개월 동안 접속하지 않으면 계정과 제출 사진이 자동으로 삭제돼요. 비밀번호를 잊으면 선생님께 재설정을 요청하세요."));
  };
  paint();
  render(card(box));
}

function viewAccount() {
  render(
    card(h("h2", {}, "내 계정"),
      h("p", {}, "아이디: ", h("strong", {}, (user.email || "").split("@")[0])),
      h("p", { class: "muted" }, "3개월 동안 접속하지 않으면 계정이 자동으로 삭제돼요."),
      h("div", { class: "actions" }, h("button", { class: "btn ghost", onclick: doLogout }, "로그아웃"))),
    card(h("h3", {}, "계정 삭제"),
      h("p", { class: "muted" }, "계정, 가입 정보, 제출한 사진이 모두 삭제되고 되돌릴 수 없어요."),
      h("button", {
        class: "btn danger",
        onclick: (e) => confirm("정말 계정을 삭제할까요? 제출한 사진도 모두 사라져요.") && run(e.currentTarget, async () => {
          try { await disablePush(); } catch { /* 무시 */ }
          await callWorker("delete_me", {}, true);
          await sb.auth.signOut().catch(() => {});
          location.hash = "#/";
          toast("계정을 삭제했어요.");
        }),
      }, "계정 삭제")));
}

/* ---------- 관리자: 로그인 ---------- */
function viewAdminLogin() {
  if (user) {
    render(card(h("h2", {}, "관리자 권한이 없어요"),
      h("p", {}, "이 계정은 관리자로 등록되어 있지 않아요. 선생님이라면 로그아웃 후 선생님 이메일로 로그인하세요."),
      h("code", { class: "uid" }, user.email || user.id),
      h("button", { class: "btn ghost", onclick: doLogout }, "로그아웃")));
    return;
  }
  const email = h("input", { type: "email", required: true, autocomplete: "username" });
  const pw = h("input", { type: "password", required: true, autocomplete: "current-password" });
  const form = h("form", {
    onsubmit: (e) => {
      e.preventDefault();
      run(e.submitter, async () => {
        const { error } = await sb.auth.signInWithPassword({ email: email.value.trim(), password: pw.value });
        if (error) throw error;
      });
    },
  }, h("label", {}, "이메일"), email, h("label", {}, "비밀번호"), pw,
  h("div", { class: "actions" }, h("button", { class: "btn" }, "로그인")));
  render(card(h("h2", {}, "선생님 로그인"), form,
    h("p", {}, h("a", { href: "#/" }, "← 학생 로그인으로"))));
}

/* ---------- 관리자: 클래스 ---------- */
async function createClass(name) {
  for (let i = 0; i < 5; i++) {
    const { error } = await sb.from("classes").insert({ name, code: genCode() });
    if (!error) return;
    if (error.code !== "23505") throw error;
  }
  throw new Error("클래스 코드 생성에 실패했어요. 다시 시도해 주세요.");
}
async function loadClasses() {
  return must(await sb.from("classes").select("*").order("name"));
}

async function viewAdminClasses() {
  const [classes, members] = await Promise.all([loadClasses(), sb.from("memberships").select("*").then(must)]);

  const nameIn = h("input", { required: true, maxlength: 40, placeholder: "예: 중3 수학 화목토" });
  const createForm = h("form", {
    onsubmit: (e) => {
      e.preventDefault();
      run(e.submitter, async () => { await createClass(nameIn.value.trim()); route(); });
    },
  }, h("label", {}, "새 클래스 이름"), nameIn, h("div", { class: "actions" }, h("button", { class: "btn" }, "클래스 만들기")));

  const act = (btn, fn) => run(btn, async () => { await fn(); route(); });
  const blocks = classes.map((c) => {
    const ms2 = members.filter((m) => m.class_id === c.id);
    const pending = ms2.filter((m) => m.status === "pending").sort(byName);
    const approved = ms2.filter((m) => m.status === "approved").sort(byName);
    const memRow = (m, btns) => h("div", { class: "list-item" },
      h("span", {}, m.name, m.login_id ? h("span", { class: "muted" }, "  (" + m.login_id + ")") : null), h("span", {}, btns));
    const delMem = (m) => sb.from("memberships").delete().eq("class_id", m.class_id).eq("user_id", m.user_id).then(must);
    return card(
      h("h2", {}, c.name),
      h("div", {}, "참여 코드 ", h("span", { class: "code" }, c.code)),
      h("h3", { style: "margin-top:14px" }, `가입 대기 (${pending.length})`),
      pending.length ? pending.map((m) => memRow(m, [
        h("button", {
          class: "btn sm",
          onclick: (e) => act(e.currentTarget, async () => {
            must(await sb.from("memberships").update({ status: "approved" }).eq("class_id", m.class_id).eq("user_id", m.user_id));
          }),
        }, "승인"),
        " ",
        h("button", { class: "btn danger sm", onclick: (e) => act(e.currentTarget, () => delMem(m)) }, "거절"),
      ])) : h("p", { class: "muted" }, "대기 중인 신청이 없어요."),
      h("h3", { style: "margin-top:14px" }, `학생 (${approved.length})`),
      approved.length ? approved.map((m) => memRow(m, [
        m.login_id ? h("button", {
          class: "btn ghost sm",
          onclick: (e) => run(e.currentTarget, async () => {
            const pw = prompt(`${m.name} (${m.login_id}) 학생의 새 비밀번호 (8자 이상)`);
            if (!pw) return;
            await callWorker("reset_password", { login_id: m.login_id, password: pw }, true);
            toast("비밀번호를 바꿨어요. 학생에게 알려주세요.");
          }),
        }, "비번 재설정") : null,
        " ",
        h("button", {
          class: "btn danger sm",
          onclick: (e) => confirm(`${m.name} 학생을 이 클래스에서 제거할까요?`) && act(e.currentTarget, () => delMem(m)),
        }, "제거")])) : h("p", { class: "muted" }, "아직 학생이 없어요."),
      h("div", { class: "actions" },
        h("button", {
          class: "btn danger sm",
          onclick: (e) => confirm(`'${c.name}' 클래스를 삭제할까요? 포스트와 제출물이 PDF 없이 모두 삭제돼요.`) &&
            act(e.currentTarget, async () => {
              const ps = must(await sb.from("posts").select("*").eq("class_id", c.id));
              for (const p of ps) await purgePost(p);
              must(await sb.from("classes").delete().eq("id", c.id));
            }),
        }, "클래스 삭제")));
  });

  render(card(h("h2", {}, "클래스 관리"), createForm), ...blocks);
}

/* ---------- 관리자: 새 포스트 ---------- */
async function viewAdminNew() {
  const classes = await loadClasses();
  if (!classes.length) {
    render(card(h("p", {}, "먼저 클래스를 만들어 주세요."), h("a", { class: "btn", href: "#/admin" }, "클래스 만들기")));
    return;
  }
  const title = h("input", { required: true, maxlength: 100, placeholder: "제목" });
  const body = h("textarea", { rows: 6, placeholder: "내용 (줄바꿈 유지됩니다)" });
  const aiCriteria = h("textarea", {
    rows: 3,
    maxlength: 600,
    placeholder: "예: 1~10번 문제 풀이 과정이 모두 적혀 있는지, 오답 해설이 포함되었는지 확인",
  });
  const checks = classes.map((c) => ({ c, input: h("input", { type: "checkbox" }) }));
  const linkEd = rowsEditor(["표시 이름 (선택)", "https://..."], "+ 링크 추가");
  const ytEd = rowsEditor(["YouTube 주소"], "+ 유튜브 추가");
  const imgIn = h("input", { type: "file", accept: "image/*", multiple: true });
  const vidIn = h("input", { type: "file", accept: "video/*", multiple: true });

  const inOneHour = new Date(Date.now() + 3600000); inOneHour.setMinutes(0, 0, 0);
  const sched = h("input", { type: "checkbox" });
  const publishAt = h("input", { type: "datetime-local", value: toLocalInput(inOneHour), disabled: true });
  sched.addEventListener("change", () => { publishAt.disabled = !sched.checked; });

  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(23, 59, 0, 0);
  const deadline = h("input", { type: "datetime-local", required: true, value: toLocalInput(tomorrow) });
  const retention = h("input", { type: "number", min: 1, max: 14, value: 7, required: true, style: "width:90px" });
  const status = h("p", { class: "muted" });

  const form = h("form", {
    onsubmit: (e) => {
      e.preventDefault();
      run(e.submitter, async () => {
        const cids = checks.filter((x) => x.input.checked).map((x) => x.c.id);
        if (!cids.length) throw new Error("클래스를 하나 이상 선택하세요.");
        const dl = new Date(deadline.value);
        if (isNaN(dl)) throw new Error("마감 시간을 입력하세요.");
        const pub = sched.checked ? new Date(publishAt.value) : new Date();
        if (isNaN(pub)) throw new Error("공개 시각을 입력하세요.");
        if (dl <= pub) throw new Error("마감 시간은 공개 시각보다 뒤여야 해요.");
        const keep = Math.round(Number(retention.value));
        if (!(keep >= 1 && keep <= 14)) throw new Error("자동 삭제 기간은 1~14일로 설정하세요.");
        const ytRaw = ytEd.values();
        const youtube = ytRaw.map((v) => ytId(v[0])).filter(Boolean);
        if (youtube.length !== ytRaw.length) throw new Error("올바르지 않은 YouTube 주소가 있어요.");
        const linkRaw = linkEd.values();
        const links = linkRaw.map(([label, url]) => ({ label: label || url, url: safeUrl(url || "") })).filter((l) => l.url);
        if (links.length !== linkRaw.length) throw new Error("올바르지 않은 링크가 있어요. (http:// 또는 https:// 로 시작)");
        const vids = [...vidIn.files];
        if (vids.some((f) => f.size > 50 * 1024 * 1024)) throw new Error("영상은 파일당 50MB 이하만 올릴 수 있어요. 큰 영상은 YouTube로 올려 주소를 넣으세요.");

        const gid = crypto.randomUUID();
        const images = [], videos = [];
        let n = 0;
        for (const f of imgIn.files) {
          status.textContent = `사진 업로드 중... (${++n}/${imgIn.files.length})`;
          images.push(await uploadFile("post-media", await compressImage(f, 2000), `${gid}/${crypto.randomUUID()}.jpg`, "image/jpeg"));
        }
        n = 0;
        for (const f of vids) {
          status.textContent = `영상 업로드 중... (${++n}/${vids.length})`;
          const ext = (f.name.split(".").pop() || "mp4").replace(/[^a-z0-9]/gi, "").slice(0, 5) || "mp4";
          videos.push(await uploadFile("post-media", f, `${gid}/${crypto.randomUUID()}.${ext}`, f.type || "video/mp4"));
        }
        status.textContent = "저장 중...";
        const baseRows = cids.map((cid) => ({
          class_id: cid, group_id: gid, title: title.value.trim(), body: body.value.trim(),
          links, youtube, images, videos,
          publish_at: pub.toISOString(), deadline: dl.toISOString(), retention_days: keep,
        }));
        const criteriaVal = aiCriteria.value.trim();
        if (criteriaVal) {
          const withCriteria = baseRows.map((r) => ({ ...r, ai_criteria: criteriaVal }));
          const ins = await sb.from("posts").insert(withCriteria);
          if (ins.error) {
            if (/ai_criteria|column/i.test(ins.error.message || "")) {
              must(await sb.from("posts").insert(baseRows));
            } else {
              throw ins.error;
            }
          }
        } else {
          must(await sb.from("posts").insert(baseRows));
        }
        toast(sched.checked ? `예약했어요. ${fmt(pub.toISOString())}에 학생들에게 공개돼요.` : "포스트 등록");
        location.hash = "#/admin/posts";
      }).finally(() => { status.textContent = ""; });
    },
  },
  h("label", {}, "올릴 클래스 (중복 선택 가능)"),
  h("div", { class: "checks" }, checks.map((x) => h("label", {}, x.input, x.c.name))),
  h("label", {}, "제목"), title,
  h("label", {}, "글"), body,
  h("label", {}, "제미나이 AI 검사 기준 (선택)"), aiCriteria,
  h("label", {}, "링크"), linkEd.el,
  h("label", {}, "유튜브 영상"), ytEd.el,
  h("label", {}, "사진 첨부"), imgIn,
  h("label", {}, "영상 파일 첨부 (파일당 50MB 이하)"), vidIn,
  h("label", {}, "공개 시점"),
  h("div", { class: "checks" }, h("label", {}, sched, "예약 게시")),
  publishAt,
  h("p", { class: "muted" }, "체크하지 않으면 지금 바로 공개돼요. 예약하면 그 시각 전에는 학생에게 보이지 않고, 공개되는 순간 알림이 가요."),
  h("label", {}, "제출 마감 시간"), deadline,
  h("label", {}, "자동 삭제: 마감 후 며칠 뒤? (1~14일)"),
  h("div", { class: "row", style: "align-items:center" }, retention, h("span", { class: "muted" }, "일 뒤 삭제")),
  h("p", { class: "muted" }, "보관 기간(마감 후 최대 14일)이 끝나면 PDF 저장 여부와 관계없이 서버가 자동으로 삭제해요. 지우기 전에 PDF를 꼭 저장하세요."),
  status,
  h("div", { class: "actions" }, h("button", { class: "btn" }, "포스트 올리기")));

  render(card(h("h2", {}, "새 포스트"), form));
}

/* ---------- 관리자: 포스트 목록 / 상세 ---------- */
function stateBadges(p, now) {
  const scheduled = ms(p.publish_at) > now;
  const open = ms(p.deadline) > now;
  return h("span", {},
    scheduled ? h("span", { class: "badge warn" }, `예약 · ${fmt(p.publish_at)} 공개`)
      : h("span", { class: "badge " + (open ? "ok" : "bad") }, open ? "제출 가능" : "마감"),
    p.exported_at ? [" ", h("span", { class: "badge ok" }, "PDF 저장됨")] : null);
}

async function viewAdminPosts() {
  const all = must(await sb.from("posts").select("*, classes(name)").order("created_at", { ascending: false }));
  const now = Date.now();
  render(card(h("h2", {}, "포스트"), h("a", { class: "btn", href: "#/admin/new" }, "+ 새 포스트")),
    ...(all.length ? all.map((p) => card(
      h("div", {}, h("span", { class: "badge" }, p.classes?.name || ""), " ", stateBadges(p, now)),
      h("h3", { style: "margin-top:8px" }, p.title),
      h("p", { class: "muted" }, `마감 ${fmt(p.deadline)} · 자동 삭제 ${fmt(p.expires_at)}`),
      h("div", { class: "actions" },
        h("a", { class: "btn sm", href: `#/admin/post/${p.class_id}/${p.id}` }, "열기 / 제출 현황"),
        h("button", { class: "btn ghost sm", onclick: (e) => run(e.currentTarget, async () => { await exportPostPdf(p); toast("PDF를 저장했어요. (자동 삭제 전에 저장해 두면 안전해요)"); route(); }) }, "PDF 저장"),
        h("button", {
          class: "btn ghost sm",
          onclick: (e) => confirm("PDF로 저장한 뒤 이 포스트와 제출물을 삭제할까요?") && run(e.currentTarget, () => exportAndPurge([p])),
        }, "PDF 저장 후 삭제"),
        h("button", {
          class: "btn danger sm",
          onclick: (e) => confirm("PDF 없이 바로 삭제할까요? 되돌릴 수 없어요.") &&
            run(e.currentTarget, async () => { await purgePost(p); route(); }),
        }, "바로 삭제")))) : [card(h("p", { class: "muted" }, "아직 포스트가 없어요."))]));
}

async function viewAdminPost(cid, pid) {
  const raw = must(await sb.from("posts").select("*, classes(name)").eq("id", pid).eq("class_id", cid).maybeSingle());
  if (!raw) throw new Error("포스트를 찾을 수 없어요.");
  const [p, members, subs] = await Promise.all([
    resolvePost(raw),
    sb.from("memberships").select("user_id,name").eq("class_id", cid).eq("status", "approved").then(must),
    sb.from("submissions").select("*").eq("post_id", pid).then(must),
  ]);
  members.sort(byName);
  const urlMap = await signMap("submissions", subs.flatMap((s) => (s.photos || []).map((x) => x.path)));
  const subMap = new Map(subs.map((s) => [s.user_id, s]));
  const doneCount = members.filter((m) => subMap.has(m.user_id)).length;
  const scheduled = ms(p.publish_at) > Date.now();

  const pubIn = h("input", { type: "datetime-local", value: toLocalInput(new Date(p.publish_at)), disabled: !scheduled });
  const dlIn = h("input", { type: "datetime-local", value: toLocalInput(new Date(p.deadline)) });
  const keepIn = h("input", { type: "number", min: 1, max: 14, value: p.retention_days, style: "width:90px" });
  const save = h("button", {
    class: "btn sm",
    onclick: (e) => run(e.currentTarget, async () => {
      const d = new Date(dlIn.value);
      const keep = Math.round(Number(keepIn.value));
      if (isNaN(d)) throw new Error("마감 시간을 입력하세요.");
      if (!(keep >= 1 && keep <= 14)) throw new Error("자동 삭제 기간은 1~14일로 설정하세요.");
      const patch = { deadline: d.toISOString(), retention_days: keep };
      if (scheduled) {
        const pub = new Date(pubIn.value);
        if (isNaN(pub)) throw new Error("공개 시각을 입력하세요.");
        patch.publish_at = pub.toISOString();
      }
      if (d <= new Date(patch.publish_at || p.publish_at)) throw new Error("마감 시간은 공개 시각보다 뒤여야 해요.");
      must(await sb.from("posts").update(patch).eq("id", pid));
      toast("저장했어요.");
      route();
    }),
  }, "저장");

  render(
    card(h("a", { href: "#/admin/posts", class: "muted" }, "← 포스트 목록"),
      h("div", { style: "margin-top:8px" }, h("span", { class: "badge" }, p.classes?.name || ""), " ", stateBadges(p, Date.now())),
      h("h2", { style: "margin-top:8px" }, p.title), postContent(p),
      scheduled ? [h("label", {}, "공개 시각 (예약 중일 때만 수정 가능)"), pubIn] : null,
      h("label", {}, "제출 마감"), dlIn,
      h("label", {}, "마감 후 자동 삭제까지 (일, 1~14)"),
      h("div", { class: "row", style: "align-items:center" }, keepIn, save),
      h("p", { class: "muted" }, `자동 삭제 예정: ${fmt(p.expires_at)} (PDF 저장 여부와 관계없이 삭제돼요)`),
      h("div", { class: "actions" },
        h("button", { class: "btn ghost sm", onclick: (e) => run(e.currentTarget, async () => { await exportPostPdf(raw); toast("PDF를 저장했어요."); route(); }) }, "PDF 저장"),
        h("button", {
          class: "btn ghost sm",
          onclick: (e) => confirm("PDF로 저장한 뒤 이 포스트와 제출물을 삭제할까요?") && run(e.currentTarget, () => exportAndPurge([raw])),
        }, "PDF 저장 후 삭제"))),
    card(
      h("h2", {}, `제출 현황 (${doneCount} / ${members.length}명)`),
      h("p", { class: "muted" }, "제출 학생별 [제미나이 검사]를 누르면 제출 사진을 분석해 검사 기준 충족 여부와 부족한 점을 띄워줘요. ",
        h("a", { href: "#/admin/ai" }, "AI 설정")),
      members.length ? members.map((m) => {
        const s = subMap.get(m.user_id);
        const photosWithUrl = s ? withUrls(s.photos, urlMap) : [];
        const cacheKey = `${pid}:${m.user_id}`;
        const aiOut = h("div", { class: "ai-box", style: aiCommentCache.has(cacheKey) ? "" : "display:none" },
          h("div", { class: "ai-box-title" }, "제미나이 코멘트"),
          h("div", {}, aiCommentCache.get(cacheKey) || "")
        );

        const aiBtn = s && photosWithUrl.length ? h("button", {
          class: "btn ghost sm",
          onclick: (e) => run(e.currentTarget, async () => {
            aiOut.style.display = "block";
            aiOut.lastChild.textContent = "제미나이가 제출 이미지를 분석 중이에요...";
            const comment = await analyzeSubmissionWithGemini({
              post: raw,
              studentName: m.name,
              photos: photosWithUrl,
            });
            aiCommentCache.set(cacheKey, comment);
            aiOut.lastChild.textContent = comment;
            toast(`${m.name} 학생 제미나이 검사 완료`);
          }),
        }, aiCommentCache.has(cacheKey) ? "제미나이 재검사" : "제미나이 검사") : null;

        return h("div", { class: "list-item", style: "display:block" },
          h("div", { style: "display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap" },
            h("strong", {}, m.name),
            h("div", { style: "display:flex;align-items:center;gap:6px;flex-wrap:wrap" },
              s ? h("span", { class: "badge ok" }, "제출 " + fmt(s.submitted_at)) : h("span", { class: "badge warn" }, "미제출"),
              aiBtn
            )),
          s ? photoGrid(photosWithUrl) : null,
          s ? aiOut : null);
      }) : h("p", { class: "muted" }, "제출한 학생이 없어요.")));
}

/* ---------- 학생 ---------- */
async function viewStudentHome() {
  const list = must(await sb.from("memberships").select("*").eq("user_id", user.id));
  const approved = list.filter((m) => m.status === "approved");
  const pending = list.filter((m) => m.status === "pending");

  const code = h("input", { required: true, maxlength: 10, placeholder: "선생님이 알려준 코드", autocapitalize: "characters" });
  const name = h("input", { required: true, maxlength: 30, placeholder: "내 이름" });
  const joinForm = h("form", {
    onsubmit: (e) => {
      e.preventDefault();
      run(e.submitter, async () => {
        const res = must(await sb.rpc("join_class", { p_code: code.value, p_name: name.value }));
        if (typeof res === "string" && res.startsWith("ERR:")) { toast(res.slice(4)); return; }
        toast("신청했어요! 선생님이 승인하면 알려드릴게요.");
        route();
      });
    },
  }, h("label", {}, "클래스 코드"), code, h("label", {}, "이름"), name,
  h("div", { class: "actions" }, h("button", { class: "btn" }, "참여 신청")));

  render(
    card(h("h2", {}, "내 클래스"),
      approved.length ? approved.map((m) => h("a", { class: "item-link", href: `#/c/${m.class_id}` },
        h("div", { class: "list-item" }, h("span", {}, h("strong", {}, m.class_name), h("span", { class: "muted" }, "  ·  " + m.name)), h("span", {}, "→"))))
        : h("p", { class: "muted" }, "아직 참여 중인 클래스가 없어요. 아래에서 코드를 입력해 신청하세요.")),
    !pushOn && pushSupported() ? card(h("p", { class: "muted", style: "margin:0" }, "📲 새 과제와 마감 알림을 앱이 닫혀 있어도 받으려면 "),
      h("a", { href: "#/notifications" }, "푸시 알림 켜기")) : null,
    pending.length ? card(h("h3", {}, "승인 대기 중"),
      pending.map((m) => h("div", { class: "list-item" },
        h("span", {}, m.class_name, h("span", { class: "muted" }, "  ·  " + m.name)),
        h("button", {
          class: "btn ghost sm",
          onclick: (e) => run(e.currentTarget, async () => {
            must(await sb.from("memberships").delete().eq("class_id", m.class_id).eq("user_id", user.id));
            route();
          }),
        }, "신청 취소")))) : null,
    card(h("h3", {}, "클래스 참여하기 (여러 개 가능)"), joinForm));
}

async function viewStudentClass(cid) {
  const m = must(await sb.from("memberships").select("*").eq("class_id", cid).eq("user_id", user.id).maybeSingle());
  if (!m || m.status !== "approved") {
    render(card(h("p", {}, "아직 이 클래스에 참여할 수 없어요. (승인 대기 중이거나 신청하지 않았어요)"), h("a", { class: "btn", href: "#/" }, "돌아가기")));
    return;
  }
  const posts = must(await sb.from("posts").select("id,title,deadline,publish_at").eq("class_id", cid).order("publish_at", { ascending: false }));
  const done = new Set();
  if (posts.length) {
    must(await sb.from("submissions").select("post_id").eq("user_id", user.id).in("post_id", posts.map((p) => p.id)))
      .forEach((s) => done.add(s.post_id));
  }
  const now = Date.now();
  render(card(h("a", { href: "#/", class: "muted" }, "← 내 클래스"), h("h2", { style: "margin-top:8px" }, m.class_name),
    h("p", { class: "muted" }, m.name + " 학생")),
  ...(posts.length ? posts.map((p) => {
    const open = ms(p.deadline) > now;
    return h("a", { class: "item-link", href: `#/c/${cid}/p/${p.id}` }, card(
      h("div", {},
        done.has(p.id) ? h("span", { class: "badge ok" }, "제출 완료") : h("span", { class: "badge " + (open ? "warn" : "bad") }, open ? "미제출" : "마감 (미제출)")),
      h("h3", { style: "margin-top:8px" }, p.title),
      h("p", { class: "muted" }, "마감 " + fmt(p.deadline))));
  }) : [card(h("p", { class: "muted" }, "아직 올라온 과제가 없어요."))]));
}

function formatRemain(msLeft) {
  const s = Math.floor(msLeft / 1000);
  const d = Math.floor(s / 86400), hh = Math.floor((s % 86400) / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  return `${d ? d + "일 " : ""}${hh}시간 ${String(mm).padStart(2, "0")}분 ${String(ss).padStart(2, "0")}초`;
}

async function viewStudentPost(cid, pid) {
  const m = must(await sb.from("memberships").select("*").eq("class_id", cid).eq("user_id", user.id).maybeSingle());
  if (!m || m.status !== "approved") throw new Error("이 클래스에 참여할 수 없어요.");
  const [raw, sub] = await Promise.all([
    sb.from("posts").select("*").eq("id", pid).eq("class_id", cid).maybeSingle().then(must),
    sb.from("submissions").select("*").eq("post_id", pid).eq("user_id", user.id).maybeSingle().then(must),
  ]);
  if (!raw) throw new Error("과제를 찾을 수 없어요. (아직 공개 전이거나 삭제됐을 수 있어요)");
  const p = await resolvePost(raw);
  const subUrls = sub ? await signMap("submissions", (sub.photos || []).map((x) => x.path)) : new Map();
  const dl = ms(p.deadline);

  const countdown = h("div", { class: "countdown" });
  const fileIn = h("input", { type: "file", accept: "image/*", multiple: true });
  const preview = h("div", { class: "photos", style: "margin-top:8px" });
  const submitBtn = h("button", { class: "btn" }, sub ? "다시 제출 (기존 사진 교체)" : "제출하기");
  const closedMsg = h("p", { class: "muted" });

  fileIn.addEventListener("change", () => {
    preview.replaceChildren(...[...fileIn.files].slice(0, 10).map((f) => h("img", { src: URL.createObjectURL(f), alt: "미리보기" })));
  });

  const tick = () => {
    const remain = dl - Date.now();
    const closed = remain <= 0;
    countdown.textContent = closed ? "제출이 마감됐어요" : "남은 시간 " + formatRemain(remain);
    countdown.classList.toggle("closed", closed);
    fileIn.disabled = closed;
    submitBtn.disabled = closed;
    closedMsg.textContent = closed ? "마감 시간이 지나 더 이상 제출하거나 수정할 수 없어요." : "";
  };
  tick();
  timers.push(setInterval(tick, 1000));

  const form = h("form", {
    onsubmit: (e) => {
      e.preventDefault();
      run(submitBtn, async () => {
        const files = [...fileIn.files];
        if (!files.length) throw new Error("사진을 선택하세요.");
        if (files.length > 10) throw new Error("사진은 최대 10장까지 올릴 수 있어요.");
        if (Date.now() >= dl) throw new Error("마감 시간이 지났어요.");
        submitBtn.textContent = "업로드 중...";
        const photos = [];
        try {
          for (const f of files) {
            const blob = await compressImage(f);
            photos.push(await uploadFile("submissions", blob, `${cid}/${pid}/${user.id}/${crypto.randomUUID()}.jpg`, "image/jpeg"));
          }
          must(await sb.from("submissions").upsert({ post_id: pid, user_id: user.id, photos }, { onConflict: "post_id,user_id" }));
        } catch (err) {
          if (photos.length) await sb.storage.from("submissions").remove(photos.map((x) => x.path)).catch(() => {});
          throw err;
        }
        const old = (sub?.photos || []).map((x) => x.path);
        if (old.length) await sb.storage.from("submissions").remove(old);
        toast("제출 완료!");
        route();
      }).finally(() => tick());
    },
  }, fileIn, preview, h("div", { class: "actions" }, submitBtn), closedMsg);

  render(
    card(h("a", { href: `#/c/${cid}`, class: "muted" }, "← 과제 목록"),
      h("h2", { style: "margin-top:8px" }, p.title), postContent(p)),
    card(h("h2", {}, "제출"),
      h("p", { class: "muted" }, "마감 " + fmt(p.deadline)), countdown,
      sub ? h("div", { style: "margin:12px 0" },
        h("span", { class: "badge ok" }, "제출 완료 " + fmt(sub.submitted_at)),
        h("div", { style: "margin-top:8px" }, photoGrid(withUrls(sub.photos, subUrls)))) : null,
      h("label", {}, sub ? "다시 제출하려면 사진을 선택하세요 (최대 10장)" : "숙제 사진을 선택하세요 (최대 10장)"),
      form));
}