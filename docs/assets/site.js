/* 站点外壳：主题 / 阅读进度 / 术语提示 / 双目录同步 / 阅读位置记忆 / 术语表检索

   设计取舍：
   - 左右两个目录必须同源。之前左侧「当前节」写死在 HTML 里，右侧靠
     IntersectionObserver 更新，滚到 2.3 时两边会打架。现在一次观察、两处着色。
   - 阅读位置写进 localStorage，回到首页时给一条「接着读」，而不是让人重找。
*/

(function () {
  "use strict";

  var root = document.documentElement;

  /* ========== 主题 ========== */

  var KEY = "dsh-theme";
  var modes = ["auto", "light", "dark"];
  var labels = { auto: "自动", light: "亮色", dark: "暗色" };

  function systemDark() {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  }

  function apply(mode) {
    var dark = mode === "dark" || (mode === "auto" && systemDark());
    root.dataset.theme = dark ? "dark" : "light";
    root.dataset.mode = mode;
    paintTokens();
  }

  /* 规范页的色卡不手抄 hex：直接从计算后的样式里读。
     手抄的值迟早会和 token 对不上，而对不上的规范比没有规范更误导。 */
  function paintTokens() {
    var nodes = document.querySelectorAll("[data-token]");
    if (!nodes.length) return;
    var cs = window.getComputedStyle(root);
    Array.prototype.forEach.call(nodes, function (el) {
      var v = cs.getPropertyValue(el.dataset.token).trim();
      if (v) el.textContent = v;
    });
  }

  function readMode() {
    try {
      var v = localStorage.getItem(KEY);
      return modes.indexOf(v) >= 0 ? v : "auto";
    } catch (e) {
      return "auto";
    }
  }

  apply(readMode());

  /* 走查参数：只解析一次。?theme=light 用来在截图时钉死主题 ——
     设计走查必须两套主题各截一轮，不能靠机器当前的系统偏好。 */
  var Q = new URLSearchParams(location.search);
  function num(name) {
    var v = Q.get(name);
    return v !== null && v !== "" && !isNaN(+v) ? +v : null;
  }

  var forced = Q.get("theme");
  if (forced === "light" || forced === "dark") apply(forced);

  if (window.matchMedia("(prefers-color-scheme: dark)").addEventListener) {
    window
      .matchMedia("(prefers-color-scheme: dark)")
      .addEventListener("change", function () {
        if (root.dataset.mode === "auto") apply("auto");
      });
  }

  /* ========== 阅读位置记忆 ========== */

  var LAST = "dsh-last";

  function saveLast(obj) {
    try {
      localStorage.setItem(LAST, JSON.stringify(obj));
    } catch (e) {}
  }

  function loadLast() {
    try {
      var v = JSON.parse(localStorage.getItem(LAST) || "null");
      return v && typeof v === "object" && v.page ? v : null;
    } catch (e) {
      return null;
    }
  }

  document.addEventListener("DOMContentLoaded", function () {
    /* ---------- 主题按钮 ---------- */

    var btn = document.querySelector("[data-theme-toggle]");
    if (btn) {
      var paint = function () {
        var l = labels[root.dataset.mode] || "自动";
        btn.textContent = l;
        btn.setAttribute("aria-label", "当前主题：" + l + "，点击切换");
      };
      paint();
      btn.addEventListener("click", function () {
        var i = modes.indexOf(root.dataset.mode);
        var next = modes[(i + 1) % modes.length];
        apply(next);
        try {
          localStorage.setItem(KEY, next);
        } catch (e) {}
        paint();
      });
    }

    /* ---------- 阅读进度 ---------- */

    var bar = document.querySelector("[data-progress]");
    var rafId = 0;

    function scrollPct() {
      var h = document.documentElement;
      var max = h.scrollHeight - h.clientHeight;
      return max > 0 ? h.scrollTop / max : 0;
    }

    function paintProgress() {
      rafId = 0;
      if (!bar) return;
      var p = scrollPct();
      bar.style.width = (p * 100).toFixed(2) + "%";
      bar.setAttribute("aria-valuenow", String(Math.round(p * 100)));
    }

    var onScroll = function () {
      if (!rafId) rafId = requestAnimationFrame(paintProgress);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    paintProgress();

    /* 走查用：?scroll=0.5 滚到一半 */
    var sp = num("scroll");
    if (sp !== null) {
      setTimeout(function () {
        root.style.scrollBehavior = "auto";
        window.scrollTo(0, (root.scrollHeight - root.clientHeight) * sp);
        setTimeout(function () {
          root.style.scrollBehavior = "";
        }, 60);
      }, 220);
    }

    /* ---------- 术语提示 ---------- */

    var tip = null;

    function ensureTip() {
      if (!tip) {
        tip = document.createElement("div");
        tip.className = "tip";
        tip.setAttribute("role", "tooltip");
        tip.innerHTML = '<span class="tip__k"></span><span class="tip__d"></span>';
        document.body.appendChild(tip);
      }
      return tip;
    }

    function showTip(el) {
      var t = ensureTip();
      t.firstChild.textContent = el.dataset.tipKey || el.textContent.trim();
      t.lastChild.textContent = el.dataset.tip || "";
      t.classList.remove("is-on");

      /* 先量再定位，避免气泡跑出视口 */
      var r = el.getBoundingClientRect();
      var tw = t.offsetWidth;
      var th = t.offsetHeight;
      var left = r.left + r.width / 2 - tw / 2;
      left = Math.max(12, Math.min(left, window.innerWidth - tw - 12));

      /* 向下优先：术语多在句子里，遮后文比遮上文好 */
      var top = r.bottom + 9;
      if (top + th > window.innerHeight - 12) top = r.top - th - 9;
      if (top < 12) top = 12;

      t.style.left = Math.round(left) + "px";
      t.style.top = Math.round(top) + "px";

      requestAnimationFrame(function () {
        t.classList.add("is-on");
      });
    }

    function hideTip() {
      if (tip) tip.classList.remove("is-on");
    }

    document.addEventListener("mouseover", function (e) {
      var el = e.target.closest && e.target.closest(".term");
      if (el) showTip(el);
    });

    document.addEventListener("mouseout", function (e) {
      var el = e.target.closest && e.target.closest(".term");
      if (el) hideTip();
    });

    document.addEventListener("focusin", function (e) {
      var el = e.target.closest && e.target.closest(".term");
      if (el) showTip(el);
    });

    document.addEventListener("focusout", hideTip);

    /* 触屏：点一下打开，点别处关掉 */
    document.addEventListener("click", function (e) {
      var el = e.target.closest && e.target.closest(".term");
      if (el) {
        e.preventDefault();
        showTip(el);
      } else {
        hideTip();
      }
    });

    window.addEventListener("scroll", hideTip, { passive: true });

    /* 走查用：?tip=1 展开第 2 个术语 */
    var tipIdx = num("tip");
    if (tipIdx !== null) {
      var all = document.querySelectorAll(".term");
      var pick = all[tipIdx];
      if (pick) setTimeout(function () { showTip(pick); }, 900);
    }

    /* ---------- 双目录同步 ---------- */

    /* 右侧「本页」与左侧「02 章展开的三个小节」指向同一批锚点，
       一次观察、两处着色。之前左侧写死在 HTML 上，滚到后面就开始说谎。 */
    var anchors = Array.prototype.slice.call(
      document.querySelectorAll(
        ".toc a[href^='#'], .sidetree__sub a[href^='#'], .sg-nav a[href^='#']"
      )
    );

    if (anchors.length) {
      var ids = [];
      anchors.forEach(function (a) {
        var id = a.getAttribute("href").slice(1);
        if (id && ids.indexOf(id) < 0) ids.push(id);
      });

      var targets = ids
        .map(function (id) { return document.getElementById(id); })
        .filter(Boolean);

      var current = null;

      function markCurrent(id) {
        if (id === current) return;
        current = id;
        anchors.forEach(function (a) {
          var hit = a.getAttribute("href") === "#" + id;
          a.classList.toggle("is-active", hit);
          var li = a.parentNode;
          if (li && li.tagName === "LI" && li.parentNode &&
              li.parentNode.classList.contains("sidetree__sub")) {
            li.classList.toggle("is-current", hit);
          }
        });
      }

      /* ---------- 悬浮节导航 ---------- */

      /* 每节末尾原来有一对「上一节 / 下一节」大方框。删掉的理由：
         右侧目录本来就常驻，再给一遍是把同一件事说两次，而且它每次
         出现都打断阅读。改成贴在视口右侧的两个 32px 方块，悬停才展开
         小节名 —— 想跳的时候在，不想跳的时候不占版面。 */

      var jumpPrev = document.querySelector("[data-jump-prev]");
      var jumpNext = document.querySelector("[data-jump-next]");
      var jumpPrevT = document.querySelector("[data-jump-prev-t]");
      var jumpNextT = document.querySelector("[data-jump-next-t]");
      var jumpPrevN = document.querySelector("[data-jump-prev-n]");
      var jumpNextN = document.querySelector("[data-jump-next-n]");
      var tocLinks = Array.prototype.slice.call(
        document.querySelectorAll(".toc a[href^='#']")
      );

      function labelOf(a) {
        var n = a.getAttribute("data-n");
        var t = a.textContent.replace(/\s+/g, " ").trim();
        return n ? n + " · " + t : t;
      }

      /* 常驻面上那个短码：节 → 1.2；章 → 03；目录 → 目录。
         只放箭头会被当成页面滚动（尤其它就在滚动条旁边），
         节号或「目录」二字才能说明这是跳转而不是滚动。 */
      function shortOf(a, text) {
        if (a && a.getAttribute("data-n")) return a.getAttribute("data-n");
        var m = /^\s*(\d{2})\b/.exec(text || "");
        if (m) return m[1];
        var href = (a && a.getAttribute("href")) || "";
        m = /chapter-(\d+)/.exec(href);
        if (m) return m[1].length === 1 ? "0" + m[1] : m[1];
        return "目录";
      }

      var lastJump = null;

      function setJump(id) {
        if (!jumpPrev || !tocLinks.length || id === lastJump) return;
        lastJump = id;

        var i = -1;
        for (var k = 0; k < tocLinks.length; k++) {
          if (tocLinks[k].getAttribute("href") === "#" + id) i = k;
        }
        if (i < 0) i = 0;

        var prev = tocLinks[i - 1];
        var next = tocLinks[i + 1];

        if (prev) {
          jumpPrev.setAttribute("href", prev.getAttribute("href"));
          jumpPrevT.textContent = labelOf(prev);
          jumpPrevN.textContent = shortOf(prev, "");
          jumpPrev.classList.remove("is-off");
        } else {
          /* 第一节的「上一节」= 回目录；用章尾 pager 的目标，避免另写一份导航数据 */
          var back = document.querySelector(".pager__item[href]");
          var backT = back
            ? (back.querySelector(".pager__t") || back).textContent.trim()
            : "目录";
          jumpPrev.setAttribute("href", back ? back.getAttribute("href") : "index.html");
          jumpPrevT.textContent = backT;
          jumpPrevN.textContent = shortOf(back, backT);
          jumpPrev.classList.remove("is-off");
        }

        if (next) {
          jumpNext.setAttribute("href", next.getAttribute("href"));
          jumpNextT.textContent = labelOf(next);
          jumpNextN.textContent = shortOf(next, "");
          jumpNext.classList.remove("is-off");
        } else {
          /* 最后一节：往下走就是下一章；下一章还没写就置灰，而不是给个死链。
             置灰也照样带上标题 —— 让读者知道「再往下是什么」，比只说「没写」有用。 */
          var fwd = document.querySelector(".pager__next");
          var href = fwd ? fwd.getAttribute("href") : null;
          var fwdT = fwd ? (fwd.querySelector(".pager__t") || fwd).textContent.trim() : "";
          jumpNextN.textContent = shortOf(fwd, fwdT);
          if (href) {
            jumpNext.setAttribute("href", href);
            jumpNextT.textContent = fwdT;
            jumpNext.classList.remove("is-off");
          } else {
            jumpNext.removeAttribute("href");
            jumpNextT.textContent = fwdT || "下一章还没写";
            jumpNext.classList.add("is-off");
          }
        }
      }

      /* 用滚动位置算，而不是用 IntersectionObserver 的「可见集合」。
         IO 在页面最底部会因为标题都已滚出上边界而找不到任何目标，
         标记就停在上一个，读者会以为目录坏了。
         但滚动位置法在页面最底部也有自己的失败模式：最后一节的标题
         永远顶不到判定线（页面已经没有更多可滚的了），点它就高亮不了 ——
         所以滚到底时直接判给最后一节。 */
      var calcRaf = 0;
      function updateActive() {
        calcRaf = 0;
        var line = 96;
        var cur = targets.length ? targets[0].id : null;
        for (var i = 0; i < targets.length; i++) {
          if (targets[i].getBoundingClientRect().top <= line) cur = targets[i].id;
        }
        var doc = document.documentElement;
        if (window.innerHeight + window.scrollY >= doc.scrollHeight - 2) {
          cur = targets[targets.length - 1].id;
        }
        markCurrent(cur);
        setJump(cur);
      }
      function kick() {
        if (!calcRaf) calcRaf = requestAnimationFrame(updateActive);
      }

      window.addEventListener("scroll", kick, { passive: true });
      window.addEventListener("resize", kick);
      updateActive();

      /* ---------- 记录阅读位置 ---------- */

      var page = document.body.dataset.page;
      var secNames = {};
      targets.forEach(function (t) {
        secNames[t.id] = t.textContent.replace(/\s+/g, " ").trim();
      });

      var saveTimer = 0;
      function bumpSave() {
        /* 只记正文页。规范页和术语表也有页内锚点，但它们不是「读到哪儿」，
           写进去会把首页的「接着读」顶掉。 */
        if ((page || "").indexOf("chapter") !== 0) return;
        clearTimeout(saveTimer);
        saveTimer = setTimeout(function () {
          var id = current || ids[0];
          saveLast({
            page: page || "chapter-02.html",
            chapter: document.body.dataset.chapter || "",
            section: id,
            title: secNames[id] || "",
            pct: +scrollPct().toFixed(3),
            at: Date.now()
          });
        }, 400);
      }

      window.addEventListener("scroll", function () {
        if (current) bumpSave();
      }, { passive: true });
      bumpSave();
    }

    /* ---------- 首页：接着读 ---------- */

    var resume = document.querySelector("[data-resume]");
    if (resume) {
      var last = loadLast();
      /* 只有真的读过正文页才提示；停在首页本身不算 */
      if (last && last.page && last.page.indexOf("chapter") === 0) {
        var t = resume.querySelector("[data-resume-text]");
        var a = resume.querySelector("[data-resume-link]");
        var name = last.title ? "「" + last.title + "」" : "上次的位置";
        if (t) {
          t.innerHTML = "";
          if (last.chapter) {
            t.appendChild(document.createTextNode("上次读到 " + last.chapter + " "));
          } else {
            t.appendChild(document.createTextNode("上次读到 "));
          }
          var b = document.createElement("b");
          b.textContent = name;
          t.appendChild(b);
        }
        if (a) a.href = last.page + (last.section ? "#" + last.section : "");
        resume.hidden = false;
      }
    }

    /* ---------- 术语表检索 ---------- */

    var search = document.querySelector("[data-glo-search]");
    if (search) {
      var items = Array.prototype.slice.call(document.querySelectorAll("[data-glo-item]"));
      var groups = Array.prototype.slice.call(document.querySelectorAll("[data-glo-group]"));
      var empty = document.querySelector("[data-glo-empty]");

      function filter() {
        var q = search.value.trim().toLowerCase();
        var shown = 0;
        items.forEach(function (it) {
          var hay = (it.dataset.gloItem || "").toLowerCase();
          var ok = !q || hay.indexOf(q) >= 0;
          it.hidden = !ok;
          if (ok) shown++;
        });
        groups.forEach(function (g) {
          var vis = Array.prototype.filter.call(
            g.querySelectorAll("[data-glo-item]"),
            function (it) { return !it.hidden; }
          );
          g.hidden = vis.length === 0;
          /* 计数要跟着过滤走。显示「5 条」却只列出 2 行，是另一种说谎。 */
          var c = g.querySelector("[data-glo-count]");
          if (c) c.textContent = q ? vis.length + " 条匹配" : vis.length + " 条";
        });
        if (empty) empty.hidden = shown > 0;
      }

      search.addEventListener("input", filter);

      /* ?q=turn 可以直接带一个搜索结果进来，也方便分享某条术语 */
      var q0 = Q.get("q");
      if (q0) search.value = q0;
      filter();

      /* / 聚焦搜索框，Esc 清空 */
      document.addEventListener("keydown", function (e) {
        if (e.key === "/" && document.activeElement !== search) {
          e.preventDefault();
          search.focus();
        } else if (e.key === "Escape" && document.activeElement === search) {
          search.value = "";
          filter();
          search.blur();
        }
      });
    }
  });
})();
