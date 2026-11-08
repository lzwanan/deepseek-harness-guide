/* ==========================================================================
   DeepSeek Harness 导读 — 图解动画引擎
   --------------------------------------------------------------------------
   与旧版的根本区别：旧版用 setInterval 每 3 秒换一次边框颜色，本质上是一组
   幻灯片；这里用 requestAnimationFrame 驱动一条 0→1 的连续时间轴，每一帧都
   重算位置、长度、透明度。所以「信号」是真的在管线上流动。

   三条设计约束：
   1. 一个动画只解释一件事。
   2. 必须能暂停、单步、拖动、改速、点节点跳转 —— 学习场景里「可控」比「自动播放」重要。
   3. 首尾同帧可无限循环；进入视口才播，离开即停。
   ========================================================================== */

(function () {
  "use strict";

  var REDUCE = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* 页面里可能有多张图同时在视口内。空格键必须只作用于「最靠视线中心」的那张，
     否则按一次空格两张图一起停，读者会以为坏了。 */
  var PLAYERS = [];

  document.addEventListener("keydown", function (e) {
    if (e.code !== "Space" || e.metaKey || e.ctrlKey || e.altKey) return;
    var tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "button") return;
    if (e.target.isContentEditable) return;

    var vh = window.innerHeight;
    var best = null;
    var bestD = Infinity;
    for (var i = 0; i < PLAYERS.length; i++) {
      var r = PLAYERS[i].el.getBoundingClientRect();
      /* 至少要有八成在视口内，才认为读者正在看它 */
      if (r.bottom < 90 || r.top > vh - 90) continue;
      var d = Math.abs((r.top + r.bottom) / 2 - vh / 2);
      if (d < bestD) {
        bestD = d;
        best = PLAYERS[i];
      }
    }
    if (!best) return;
    e.preventDefault();
    best.toggle();
  });

  /* ---------- 数学小工具 ---------- */

  function clamp(v, a, b) {
    return v < a ? a : v > b ? b : v;
  }
  function lerp(a, b, p) {
    return a + (b - a) * p;
  }
  function easeOut(p) {
    return 1 - Math.pow(1 - p, 3);
  }
  function easeInOut(p) {
    return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
  }
  function fmt(sec) {
    var m = Math.floor(sec / 60);
    var s = Math.round(sec % 60);
    return m + ":" + (s < 10 ? "0" : "") + s;
  }

  /* ==========================================================================
     图 1 —— 一个 step 的四段动作
     形态：一条带刻度的管线，一个信号包沿管线连续推进。
     讲的是「顺序」：四件事依次发生，走完就是一步。
     ========================================================================== */

  /* 几何约束（别再凭眼睛摆）：
     —— 轴的起止点、节点、刻度必须共用同一个 16px 网格，否则「尺子」只是装饰；
     —— 节点间距必须等于段间距（第一个节点前也要留同样长），否则信号包
        在第一段走得慢、后面飞快；
     —— 主刻度正好落在四个节点上，节点圆环下面露出一小截刻度针，
        对齐关系才看得出来。 */
  var S = {
    step: 16, // 刻度网格
    unit: 7, // 每 7 格一个主刻度 = 112
    axStart: 48,
    axEnd: 608,
    y: 62,
    nx: [160, 272, 384, 496],
    nodes: [
      { t: "取输入", e: "claim" },
      { t: "装配 prompt", e: "agent/pre-step" },
      { t: "流式请求", e: "agent/request" },
      { t: "执行 / 收尾", e: "step/end" }
    ],
    text: [
      "<b>① 取输入</b> — 从队列里拿走这一轮要处理的消息，同时冻结本次使用的模型。",
      "<b>② 装配 prompt</b> — 系统提示、历史消息、工具表被拼成一次请求。注意：每个 step 都重新装配一次。",
      "<b>③ 发起请求</b> — 过 agent/request 这道 hook 之后请求才发出去，token 一个个回来。这一步只产生文本，不做事。",
      "<b>④ 执行 / 收尾</b> — 要动手就调工具、回到 loop；不动手就写 step/end，这一步结束。"
    ]
  };

  function buildStep(root) {
    var s = [];
    var i;
    s.push(
      '<svg viewBox="0 0 640 110" role="img" aria-label="一个 step 的四段动作时序">'
    );

    /* 刻度：次刻度短、主刻度长且正好压在节点上 */
    for (var x = S.axStart; x <= S.axEnd; x += S.step) {
      var major = ((x - S.axStart) / S.step) % S.unit === 0;
      s.push(
        '<line class="d-tick' +
          (major ? " d-tick--major" : "") +
          '" x1="' +
          x +
          '" y1="' +
          (S.y + 1) +
          '" x2="' +
          x +
          '" y2="' +
          (S.y + (major ? 13 : 5)) +
          '"/>'
      );
    }

    /* 轴线 + 已走过的高亮轨迹（用 dasharray 表示生长长度） */
    s.push(
      '<line class="d-axis" x1="' +
        S.axStart +
        '" y1="' +
        S.y +
        '" x2="' +
        S.axEnd +
        '" y2="' +
        S.y +
        '"/>'
    );
    s.push(
      '<line class="d-axis-lit" data-trail x1="' +
        S.axStart +
        '" y1="' +
        S.y +
        '" x2="' +
        S.axEnd +
        '" y2="' +
        S.y +
        '" stroke-dasharray="0 1000"/>'
    );

    /* 原来这里挂着 T+0 / T+1.0 两个坐标标签，和节点事件名挤在同一行
       （step/end 与 T+1.0 会压在一起）。轴的意义由刻度和节点承担，
       标签去掉，挤的问题和「对齐不上」的观感一起消失。 */

    /* 节点 */
    S.nodes.forEach(function (n, k) {
      s.push('<g class="d-node is-off" data-i="' + k + '">');
      s.push(
        '<circle class="d-node__ring" cx="' +
          S.nx[k] +
          '" cy="' +
          S.y +
          '" r="9.5"/>'
      );
      s.push(
        '<circle class="d-node__dot" cx="' +
          S.nx[k] +
          '" cy="' +
          S.y +
          '" r="3.5"/>'
      );
      s.push(
        '<text class="d-node__t" x="' +
          S.nx[k] +
          '" y="' +
          (S.y - 30) +
          '" text-anchor="middle">' +
          n.t +
          "</text>"
      );
      s.push(
        '<text class="d-node__e" x="' +
          S.nx[k] +
          '" y="' +
          (S.y + 24) +
          '" text-anchor="middle">' +
          n.e +
          "</text>"
      );
      s.push("</g>");
    });

    /* 到达时的脉冲环 */
    s.push(
      '<circle class="d-pulse" data-pulse cx="' +
        S.nx[0] +
        '" cy="' +
        S.y +
        '" r="0" opacity="0"/>'
    );

    /* 信号包 */
    s.push(
      '<circle class="d-packet" data-pkt cx="' +
        S.axStart +
        '" cy="' +
        S.y +
        '" r="3.5"/>'
    );

    s.push("</svg>");

    var host = document.createElement("div");
    host.innerHTML = s.join("");
    var svg = host.firstChild;
    root.appendChild(svg);

    var trail = svg.querySelector("[data-trail]");
    var pkt = svg.querySelector("[data-pkt]");
    var pulse = svg.querySelector("[data-pulse]");
    var nodeEls = svg.querySelectorAll(".d-node");
    var span = S.axEnd - S.axStart;

    function paint(t) {
      var seg = t * 4;
      var i = Math.min(3, Math.floor(seg));
      var local = clamp(seg - i, 0, 1);
      var arrived = local > 0.04;

      var fromX = i === 0 ? S.axStart : S.nx[i - 1];
      var toX = i === 0 ? S.nx[0] : S.nx[i];
      var px = lerp(fromX, toX, easeInOut(local));

      pkt.setAttribute("cx", px);

      /* 轨迹一路生长，而不是一段一段跳 */
      var lit = clamp(px - S.axStart, 0, span);
      trail.setAttribute("stroke-dasharray", lit + " " + (span + 40));

      for (var k = 0; k < nodeEls.length; k++) {
        var cls = "d-node";
        if (k < i || (k === i && local > 0.96)) cls += " is-done";
        else if (k === i && arrived) cls += " is-on";
        else cls += " is-off";
        nodeEls[k].setAttribute("class", cls);
      }

      /* 到达节点瞬间的脉冲 */
      var pr = local > 0.04 ? clamp((local - 0.04) / 0.22, 0, 1) : 0;
      pulse.setAttribute("cx", S.nx[i]);
      pulse.setAttribute("r", (3 + pr * 11).toFixed(2));
      pulse.setAttribute("opacity", (pr > 0 && pr < 1 ? (1 - pr) * 0.85 : 0).toFixed(3));

      return i;
    }

    return {
      paint: paint,
      phases: 4,
      text: function (i) {
        return S.text[clamp(i, 0, 3)];
      },
      /* 点节点 = 跳到「信号包刚好停在该节点上」的那一帧。
         local 取 0.94：够近，看起来就压在圆点上；又小于 0.96，
         不会因为「已完成」而把高亮让给下一个节点。 */
      jump: function (k) {
        return clamp((k + 0.94) / 4, 0, 1);
      },
      marks: S.nx.map(function (x, k) {
        return { x: x, y: S.y, jump: clamp((k + 0.94) / 4, 0, 1) };
      })
    };
  }

  /* ==========================================================================
     图 2 —— 一个 turn 里的消息往来
     形态：三条水平泳道（LLM / TOOLS / SESSION），一个时间游标从左扫到右。
     讲的是「往返」：模型和工具之间来回几次，全部落在同一个 turn 里。
     ========================================================================== */

  /* 时序图的几何。
     两条硬约束：
     1) 竖排。横排时 620px 里要塞五条消息，标签只能压到 9px 还互相叠；
        竖排后每条消息独占一行，能写「代码 + 人话」两行。
     2) 画布用 560 而不是 640。SVG 是等比缩放的，画布越窄、字号越大——
        560 的画布放进 620 的容器，等效字号能到 11px 以上。 */
  var T = {
    boxW: 100,
    boxH: 38,
    boxY: 6,
    actors: [
      { x: 130, zh: "模型", en: "LLM" },
      { x: 290, zh: "工具", en: "TOOLS" },
      { x: 450, zh: "日志", en: "SESSION" }
    ],
    lifeTop: 46,
    lifeBottom: 292,
    curTop: 60,
    curBottom: 288,
    steps: [
      { t: "STEP 1", y0: 60, y1: 152 },
      { t: "STEP 2", y0: 152, y1: 234 },
      { t: "STEP 3", y0: 234, y1: 288 }
    ],
    /* a → b：谁对谁说话。n 是序号，code 是源码里的名字，zh 是给人看的一句话。 */
    msgs: [
      { a: 0, b: 1, y: 90, n: "①", code: "read_file(path)", zh: "模型要读这个文件" },
      { a: 1, b: 0, y: 132, n: "②", code: "84 行", zh: "文件内容回到模型" },
      { a: 0, b: 1, y: 174, n: "③", code: "grep(pattern)", zh: "模型再搜一次" },
      { a: 1, b: 0, y: 216, n: "④", code: "3 处命中", zh: "位置回到模型" },
      { a: 0, b: 2, y: 258, n: "⑤", code: "assistant/message", zh: "最终回答写入日志" }
    ],
    text: [
      "<b>开始</b> — 用户消息进入队列，一个 turn 开始。此刻 turn 里还没有任何 step。",
      "<b>第 1 次请求</b> — 模型读到 prompt，决定要读文件，于是向工具层发出 read_file。",
      "<b>工具执行</b> — read_file 真的跑了，结果回到模型那里。注意：这个结果也写进了日志。",
      "<b>第 2 次请求</b> — 带着上一步的结果再问一次，模型这次要 grep。",
      "<b>工具执行</b> — grep 返回三处命中，同样落进日志。",
      "<b>第 3 次请求</b> — 模型说：够了。这次不调工具，于是写 turn/end，整个回合结束。"
    ]
  };

  function buildTurn(root) {
    var s = [];
    s.push(
      '<svg viewBox="0 0 560 304" role="img" aria-label="一个回合内模型、工具与日志之间的消息往来">'
    );

    /* 生命线 */
    T.actors.forEach(function (a) {
      s.push(
        '<line class="d-life" x1="' + a.x + '" y1="' + T.lifeTop + '" x2="' + a.x + '" y2="' + T.lifeBottom + '"/>'
      );
    });

    /* 角色名牌：中文在上、英文在下 */
    T.actors.forEach(function (a, k) {
      s.push('<g class="d-act" data-act="' + k + '">');
      s.push(
        '<rect class="d-act__box" x="' + (a.x - T.boxW / 2) + '" y="' + T.boxY +
          '" width="' + T.boxW + '" height="' + T.boxH + '" rx="3"/>'
      );
      s.push(
        '<text class="d-act__zh" x="' + a.x + '" y="' + (T.boxY + 17) + '" text-anchor="middle">' + a.zh + '</text>'
      );
      s.push(
        '<text class="d-act__en" x="' + a.x + '" y="' + (T.boxY + 30) + '" text-anchor="middle">' + a.en + '</text>'
      );
      s.push("</g>");
    });

    /* step 分组括号：放在左边空白处，不压在图上 */
    T.steps.forEach(function (st, k) {
      s.push(
        '<path class="d-stepb" data-sb="' + k + '" d="M72 ' + st.y0 + ' H66 V' + st.y1 + ' H72"/>'
      );
      s.push(
        '<text class="d-steplabel" data-sbt="' + k + '" x="5" y="' +
          ((st.y0 + st.y1) / 2 + 3) + '">' + st.t + '</text>'
      );
    });

    /* 消息：水平箭头，时间向下 */
    T.msgs.forEach(function (m, k) {
      var x1 = T.actors[m.a].x;
      var x2 = T.actors[m.b].x;
      var dir = x2 > x1 ? 1 : -1;
      var sx = x1 + dir * 8;
      var ex = x2 - dir * 8;
      var lx = Math.min(sx, ex) + 8;

      s.push('<g class="d-msg is-off" data-msg="' + k + '">');
      s.push(
        '<path class="d-msg__path" data-p="' + k + '" d="M' + sx + ' ' + m.y +
          ' H ' + ex + '" stroke-dasharray="0 900"/>'
      );
      s.push(
        '<path class="d-msg__arrow" data-a="' + k + '" d="M' + (ex - dir * 7) + ' ' + (m.y - 4.5) +
          ' L' + ex + ' ' + m.y + ' L' + (ex - dir * 7) + ' ' + (m.y + 4.5) + ' Z" opacity="0"/>'
      );
      /* 两行：上行是源码里的名字，下行是人话。
         挤成一行会横向溢出去压到右边那条生命线。 */
      s.push(
        '<text class="d-msg__t" data-l="' + k + '" x="' + lx + '" y="' + (m.y - 18) + '">' +
          '<tspan class="d-msg__n">' + m.n + '</tspan>' +
          '<tspan class="d-msg__code" dx="5">' + m.code + '</tspan>' +
          '<tspan class="d-msg__zh" x="' + lx + '" dy="12">' + m.zh + '</tspan>' +
          '</text>'
      );
      s.push("</g>");
    });

    /* 播放头：只做一个小点在左侧分组线上移动。
       原来画的是贯通的横线，它和消息箭头几乎同高，看起来像箭头多伸出一段，
       读者会以为「模型把消息发到了日志里」。 */
    s.push(
      '<circle class="d-cursor__dot" data-cursor cx="69" cy="' + T.curTop +
        '" r="3" opacity="0"/>'
    );

    s.push("</svg>");

    var host = document.createElement("div");
    host.innerHTML = s.join("");
    var svg = host.firstChild;
    root.appendChild(svg);

    var cdot = svg.querySelector("[data-cursor]");
    var paths = svg.querySelectorAll("[data-p]");
    var arrows = svg.querySelectorAll("[data-a]");
    var labels = svg.querySelectorAll("[data-l]");
    var groups = svg.querySelectorAll("[data-msg]");

    var actEls = [];
    for (var A0 = 0; A0 < T.actors.length; A0++) {
      actEls.push(svg.querySelector('[data-act="' + A0 + '"]'));
    }
    var sbEls = [];
    var sbtEls = [];
    for (var B0 = 0; B0 < T.steps.length; B0++) {
      sbEls.push(svg.querySelector('[data-sb="' + B0 + '"]'));
      sbtEls.push(svg.querySelector('[data-sbt="' + B0 + '"]'));
    }

    var span = T.curBottom - T.curTop;

    function paint(t) {
      var cy = lerp(T.curTop, T.curBottom, t);
      cdot.setAttribute("cy", cy);
      cdot.setAttribute("opacity", "0.9");

      var active = -1;
      var lastDone = -1;

      for (var k = 0; k < T.msgs.length; k++) {
        var m = T.msgs[k];
        /* 游标接近这一行时，箭头从发起端长出来 */
        var p = clamp((cy - (m.y - 24)) / 24, 0, 1);
        var e = easeOut(p);
        var len = Math.abs(T.actors[m.b].x - T.actors[m.a].x) - 16;

        paths[k].setAttribute("stroke-dasharray", len + " 900");
        paths[k].setAttribute("stroke-dashoffset", (len * (1 - e)).toFixed(2));
        arrows[k].setAttribute("opacity", p > 0.86 ? "1" : "0");
        labels[k].setAttribute("opacity", p > 0 ? String(Math.min(1, p * 2.2).toFixed(2)) : "0");

        var cls = "d-msg";
        if (p >= 1) cls += " is-past";
        else if (p > 0) cls += " is-on";
        else cls += " is-off";
        groups[k].setAttribute("class", cls);

        if (p > 0 && p < 1 && active < 0) active = k;
        if (p >= 1) lastDone = k;
      }

      /* 高亮「正在说话」的两个角色 */
      var on = {};
      var focus = active >= 0 ? active : lastDone;
      if (focus >= 0) {
        on[T.msgs[focus].a] = 1;
        on[T.msgs[focus].b] = 1;
      }
      for (var a = 0; a < T.actors.length; a++) {
        actEls[a].classList.toggle("is-on", !!on[a]);
      }

      /* step 括号：走完的变绿 */
      for (var b = 0; b < T.steps.length; b++) {
        var done = cy > T.steps[b].y1 - 6;
        sbEls[b].classList.toggle("is-done", done);
        sbtEls[b].classList.toggle("is-done", done);
      }

      if (active >= 0) return Math.min(active + 1, T.msgs.length);
      if (lastDone >= 0) return Math.min(lastDone + 1, T.msgs.length);
      return 0;
    }

    function tAt(y) {
      return clamp((y - T.curTop) / span, 0, 1);
    }

    return {
      paint: paint,
      phases: 6,
      text: function (i) {
        return T.text[clamp(i, 0, 5)];
      },
      jump: function (k) {
        return tAt(T.steps[clamp(k, 0, 2)].y0);
      },
      /* 进度条上的分段刻，和左侧 STEP 括号同一组边界 */
      stepMarks: T.steps.slice(1).map(function (st) {
        return tAt(st.y0);
      }),
      marks: T.steps.map(function (st) {
        return { x: 69, y: (st.y0 + st.y1) / 2, jump: tAt(st.y0) };
      })
    };
  }

  /* ==========================================================================
     图 3 —— 文字与动作之间的那道边界（第 01 章）
     形态：左中右三块，中间一道闸。
     讲的是「不成立的事」：模型不执行任何东西，它只输出了一段长得像申请的
     文本。整张图要让人看见这串文本停在边界上，只有被识别的那一段过得去。
     ========================================================================== */

  var B = {
    L: { x: 10, y: 34, w: 138, h: 112 },
    M: { x: 194, y: 26, w: 172, h: 114 },
    R: { x: 398, y: 34, w: 152, h: 112 },
    gate: 176,
    mid: 92,
    tokW: 16,
    tokH: 12,
    tokX: 24,
    tokGap: 22,
    n: 6,
    parse: { x: 206, y: 46, w: 68, h: 32 },
    exec: { x: 288, y: 46, w: 68, h: 32 },
    text: [
      "<b>模型开始吐字</b> — 一次一个 token。这串方块就是它的全部产出，磁盘上什么都没有发生。",
      "<b>有一段长得不一样</b> — 文本里出现了一个 <code>tool_call</code> 结构。注意：此刻它仍然只是文本。",
      "<b>闸门打开</b> — harness 认出了这个结构，把它单独取出来。认不出，它就和普通文字一样卡在边界上。",
      "<b>动作发生在这里</b> — 真正读文件的是 harness 的工具层，不是模型。模型从头到尾没碰过磁盘。",
      "<b>结果回到上下文</b> — 文件内容被塞进下一轮请求。模型再吐字时，才「知道」文件里写了什么。"
    ]
  };

  function buildBoundary(root) {
    var s = [];
    s.push(
      '<svg viewBox="0 0 560 158" role="img" aria-label="模型只输出文字，harness 是唯一能把特定文本变成动作的一层">'
    );

    /* --- 左：MODEL --- */
    s.push(
      '<rect class="d-bd__box" data-l x="' +
        B.L.x +
        '" y="' +
        B.L.y +
        '" width="' +
        B.L.w +
        '" height="' +
        B.L.h +
        '" rx="2"/>'
    );
    s.push(
      '<text class="d-bd__k" x="' +
        (B.L.x + 12) +
        '" y="' +
        (B.L.y + 22) +
        '">MODEL</text>'
    );
    s.push(
      '<text class="d-bd__s" x="' +
        (B.L.x + 12) +
        '" y="' +
        (B.L.y + 38) +
        '">只产生 token</text>'
    );

    /* --- 右：WORLD --- */
    s.push(
      '<rect class="d-bd__box" data-w x="' +
        B.R.x +
        '" y="' +
        B.R.y +
        '" width="' +
        B.R.w +
        '" height="' +
        B.R.h +
        '" rx="2"/>'
    );
    s.push(
      '<text class="d-bd__k" x="' +
        (B.R.x + 12) +
        '" y="' +
        (B.R.y + 22) +
        '">WORLD</text>'
    );
    s.push(
      '<text class="d-bd__s" x="' +
        (B.R.x + 12) +
        '" y="' +
        (B.R.y + 38) +
        '">文件 · 命令</text>'
    );
    ["agent-loop/README.md", "agent-loop/package.json", "README.md"].forEach(
      function (f, k) {
        s.push(
          '<text class="d-bd__file" data-f' +
            k +
            ' x="' +
            (B.R.x + 12) +
            '" y="' +
            (B.R.y + 58 + k * 16) +
            '">' +
            f +
            "</text>"
        );
      }
    );

    /* --- 中：HARNESS --- */
    s.push(
      '<text class="d-bd__k" x="' +
        B.M.x +
        '" y="20">HARNESS</text>'
    );
    s.push(
      '<rect class="d-bd__frame" x="' +
        B.M.x +
        '" y="' +
        B.M.y +
        '" width="' +
        B.M.w +
        '" height="' +
        B.M.h +
        '" rx="2" stroke-dasharray="4 3"/>'
    );
    /* 两个格子：解析 / 执行 */
    ["parse", "exec"].forEach(function (k) {
      var b = B[k];
      s.push(
        '<rect class="d-bd__box" data-' +
          k +
          ' x="' +
          b.x +
          '" y="' +
          b.y +
          '" width="' +
          b.w +
          '" height="' +
          b.h +
          '" rx="2"/>'
      );
      s.push(
        '<text class="d-bd__s" x="' +
          (b.x + b.w / 2) +
          '" y="' +
          (b.y + 20) +
          '" text-anchor="middle">' +
          (k === "parse" ? "解析" : "执行") +
          "</text>"
      );
    });
    s.push(
      '<path class="d-bd__arw" d="M' +
        (B.parse.x + B.parse.w + 2) +
        " 62 H" +
        (B.exec.x - 4) +
        '"/>'
    );
    s.push(
      '<path class="d-bd__arw" d="M' +
        (B.exec.x - 8) +
        " 58 L" +
        (B.exec.x - 2) +
        " 62 L" +
        (B.exec.x - 8) +
        ' 66"/>'
    );
    s.push(
      '<text class="d-bd__note" x="' +
        B.M.x +
        '" y="' +
        (B.M.y + 92) +
        '">只放行认得出的那一段</text>'
    );
    s.push(
      '<text class="d-bd__note" x="' +
        B.M.x +
        '" y="' +
        (B.M.y + 106) +
        '">执行也在这里发生</text>'
    );

    /* --- 边界 + 闸门 --- */
    s.push(
      '<line class="d-bd__dash" x1="' +
        B.gate +
        '" y1="26" x2="' +
        B.gate +
        '" y2="140"/>'
    );
    s.push(
      '<rect class="d-bd__gate" data-g1 x="' + (B.gate - 6) + '" y="70" width="12" height="20" rx="1"/>'
    );
    s.push(
      '<rect class="d-bd__gate" data-g2 x="' + (B.gate - 6) + '" y="94" width="12" height="20" rx="1"/>'
    );

    /* --- token 方块：最后一个会被识别成 tool_call --- */
    for (var i = 0; i < B.n; i++) {
      s.push(
        '<rect class="d-bd__tok" data-t' +
          i +
          ' x="' +
          (B.tokX + i * B.tokGap) +
          '" y="' +
          (B.mid - B.tokH / 2) +
          '" width="' +
          B.tokW +
          '" height="' +
          B.tokH +
          '" rx="1.5" opacity="0"/>'
      );
    }

    /* --- HARNESS → WORLD 的去回箭头 --- */
    s.push(
      '<path class="d-bd__arw" data-a1 d="M' +
        (B.M.x + B.M.w + 4) +
        " 84 H" +
        (B.R.x - 6) +
        '"/>'
    );
    s.push(
      '<path class="d-bd__arw" data-a1h d="M' +
        (B.R.x - 12) +
        " 80 L" +
        (B.R.x - 6) +
        " 84 L" +
        (B.R.x - 12) +
        ' 88"/>'
    );
    s.push(
      '<path class="d-bd__arw" d="M' +
        (B.R.x - 6) +
        " 110 H" +
        (B.M.x + B.M.w + 4) +
        '"/>'
    );
    s.push(
      '<path class="d-bd__arw" d="M' +
        (B.M.x + B.M.w + 10) +
        " 106 L" +
        (B.M.x + B.M.w + 4) +
        " 110 L" +
        (B.M.x + B.M.w + 10) +
        ' 114"/>'
    );

    /* --- 附在方块上的两个标签 --- */
    s.push('<text class="d-bd__call" data-call text-anchor="end" opacity="0">tool_call</text>');
    s.push('<text class="d-bd__res" data-rl opacity="0">84 行</text>');
    s.push(
      '<rect class="d-bd__resbox" data-res x="535" y="83" width="30" height="14" rx="1.5" opacity="0"/>'
    );


    s.push("</svg>");

    var host = document.createElement("div");
    host.innerHTML = s.join("");
    var svg = host.firstChild;
    root.appendChild(svg);

    var wBox = svg.querySelector("[data-w]");
    var parseEl = svg.querySelector("[data-parse]");
    var execEl = svg.querySelector("[data-exec]");
    var g1 = svg.querySelector("[data-g1]");
    var g2 = svg.querySelector("[data-g2]");
    var a1 = svg.querySelector("[data-a1]");
    var a1h = svg.querySelector("[data-a1h]");
    var callLbl = svg.querySelector("[data-call]");
    var resLbl = svg.querySelector("[data-rl]");
    var resEl = svg.querySelector("[data-res]");
    var fileEls = [0, 1, 2].map(function (k) {
      return svg.querySelector("[data-f" + k + "]");
    });
    var tokEls = [];
    for (var j = 0; j < B.n; j++) tokEls.push(svg.querySelector("[data-t" + j + "]"));

    var last = tokEls[B.n - 1];
    var lastX = B.tokX + (B.n - 1) * B.tokGap;
    var parseCx = B.parse.x + 26;
    var parseCy = B.parse.y + B.parse.h / 2;

    function cls(base, on) {
      return base + (on ? " is-on" : "");
    }

    function paint(t) {
      var p1 = clamp(t / 0.2, 0, 1);
      var p2 = clamp((t - 0.2) / 0.22, 0, 1);
      var p3 = clamp((t - 0.42) / 0.2, 0, 1);
      var p4 = clamp((t - 0.62) / 0.2, 0, 1);
      var p5 = clamp((t - 0.82) / 0.18, 0, 1);

      /* 一个字一个字吐出来 */
      for (var i = 0; i < B.n; i++) {
        var k = clamp(p1 * B.n - i, 0, 1);
        /* 被取走的那一段要一直可见，直到它落进 parse 格才消失 */
        if (i === B.n - 1 && p3 > 0.98) k = 0;
        tokEls[i].setAttribute("opacity", k.toFixed(2));
      }

      /* 最后一段被识别：变色，就地浮起一点点 */
      var isCall = p2 > 0.12;
      last.setAttribute("class", "d-bd__tok" + (isCall ? " is-call" : ""));
      if (p3 <= 0) {
        last.setAttribute("x", lastX);
        last.setAttribute("y", B.mid - B.tokH / 2 - 6 * easeInOut(p2));
      }

      callLbl.setAttribute("opacity", (isCall && p3 < 0.15 ? 1 : 0).toFixed(2));
      callLbl.setAttribute("x", lastX + 14);
      callLbl.setAttribute("y", B.mid + 26);

      /* 过闸：这一段被取走，移到 parse 格里 */
      if (p3 > 0) {
        var e3 = easeInOut(p3);
        last.setAttribute("x", lerp(lastX, parseCx, e3));
        last.setAttribute("y", lerp(B.mid - B.tokH / 2 - 6, parseCy - B.tokH / 2, e3));
      }

      /* 闸门从中缝分开 */
      var gap = 2 + 30 * easeInOut(p3);
      g1.setAttribute("y", B.mid - gap / 2 - 20);
      g2.setAttribute("y", B.mid + gap / 2);
      var open = p3 > 0.05;
      g1.setAttribute("class", "d-bd__gate" + (open ? " is-open" : ""));
      g2.setAttribute("class", "d-bd__gate" + (open ? " is-open" : ""));

      parseEl.setAttribute("class", cls("d-bd__box", p3 > 0.88));
      execEl.setAttribute("class", cls("d-bd__box", p4 > 0.12));
      /* MODEL 框不点亮：这一格是「文字世界」，亮起来会让人以为那里也在做事。
         真正该亮的是那一个 token。 */
      wBox.setAttribute("class", cls("d-bd__box", p4 > 0.3));

      var arrowOn = p4 > 0.25;
      a1.setAttribute("class", cls("d-bd__arw", arrowOn));
      a1h.setAttribute("class", cls("d-bd__arw", arrowOn));

      fileEls[0].setAttribute("class", "d-bd__file" + (p4 > 0.45 ? " is-on" : ""));

      /* 结果回来：先回 harness，再回上下文 */
      if (p5 > 0) {
        resEl.setAttribute("opacity", "1");
        var e1 = clamp(p5 / 0.55, 0, 1);
        var e2 = clamp((p5 - 0.55) / 0.45, 0, 1);
        var rx, ry;
        if (e2 <= 0) {
          rx = lerp(535, 250, easeInOut(e1));
          ry = 83;
        } else {
          rx = lerp(250, 118, easeInOut(e2));
          ry = lerp(83, 108, easeInOut(e2));
        }
        resEl.setAttribute("x", rx.toFixed(1));
        resEl.setAttribute("y", ry.toFixed(1));
        resLbl.setAttribute("opacity", p5 > 0.15 ? "1" : "0");
        resLbl.setAttribute("x", (rx - 2).toFixed(1));
        resLbl.setAttribute("y", (ry + 24).toFixed(1));
      } else {
        resEl.setAttribute("opacity", "0");
        resLbl.setAttribute("opacity", "0");
      }

      if (t < 0.2) return 0;
      if (t < 0.42) return 1;
      if (t < 0.62) return 2;
      if (t < 0.82) return 3;
      return 4;
    }

    return {
      paint: paint,
      phases: 5,
      text: function (i) {
        return B.text[clamp(i, 0, 4)];
      },
      jump: function (k) {
        return clamp((clamp(k, 0, 4) + 0.5) / 5, 0, 1);
      },
      stepMarks: [0.2, 0.42, 0.62, 0.82],
      marks: []
    };
  }

  /* ==========================================================================
     图 3 —— 日志只增，历史会缩
     形态：左列事件日志、右列派生历史，两列并排、同一时间轴推进。
     讲的是「这两样不是一回事」：左边是唯一的事实，右边是每次请求前现算的视图。
     所以压缩能让右边塌下去，左边一条都不会少。
     ========================================================================== */

  var LG = {
    rowH: 18,
    topY: 62,
    rows: [
      { type: "user/message" },
      { type: "step/start" },
      { type: "assistant/message" },
      { type: "tool/call" },
      { type: "tool/result" },
      { type: "compaction/start" },
      { type: "compaction/summary" },
      { type: "user/message" }
    ],
    text: [
      "<b>左边是日志，右边是模型历史。</b>一开始两边都是空的 —— 因为右边不是存下来的，是算出来的。",
      "<b>① 写入一条 user/message。</b>它立刻出现在右边。没有任何东西被「同步」过去，是同一份数据被投影了一次。",
      "<b>② 这五条只产出三条消息。</b>step/start 和 tool/call 只是记录，模型看不见 —— 日志比对话长，是常态。",
      "<b>③ 上下文要满了。</b>compaction/start 记一笔，接着要用一条 replace 遮蔽最前面的 0…4，把三条消息压成一条摘要。",
      "<b>④ 右边塌成一行，左边一条没少。</b>replace 是<b>视图操作</b>：它让被遮蔽的条目不再进入后续请求，但不删除原记录。",
      "<b>⑤ 继续写。</b>新消息接在摘要后面。所以「日志只增、历史可缩」——回放和 fork 靠的就是前半句。"
    ]
  };

  function buildLog(root) {
    var s = [];

    s.push(
      '<svg viewBox="0 0 560 244" role="img" aria-label="只追加的事件日志，以及由它派生出来的模型历史">'
    );

    /* 两列表头 */
    s.push('<text class="d-lg__k" x="26" y="24">LOG</text>');
    s.push('<text class="d-lg__s" x="26" y="38">只追加 · seq 单调递增</text>');
    s.push('<text class="d-lg__k" x="300" y="24">MODEL HISTORY</text>');
    s.push('<text class="d-lg__s" x="300" y="38">每次请求前现算</text>');
    s.push('<line class="d-lg__rule" x1="26" y1="48" x2="252" y2="48"/>');
    s.push('<line class="d-lg__rule" x1="300" y1="48" x2="536" y2="48"/>');

    /* 被遮蔽的区间：压缩之后在左列铺一层淡底，表示「就是这五条」 */
    s.push(
      '<rect class="d-lg__band" data-band x="24" y="61" width="228" height="92" rx="2" opacity="0"/>'
    );

    /* 左列：八条事件。seq 右对齐、类型等宽 —— 它是机器记录，不是文案 */
    for (var i = 0; i < LG.rows.length; i++) {
      var y = LG.topY + i * LG.rowH + 11;
      s.push('<g data-l' + i + ' opacity="0">');
      s.push(
        '<text class="d-lg__n" data-ln' +
          i +
          '" x="44" y="' +
          y +
          '" text-anchor="end">' +
          i +
          "</text>"
      );
      s.push(
        '<text class="d-lg__e" data-le' +
          i +
          ' x="54" y="' +
          y +
          '">' +
          LG.rows[i].type +
          "</text>"
      );
      s.push("</g>");
    }

    /* 右列：三条消息 → 一条摘要 → 再来一条。
       摘要占据了第 0 行，最后那条 user/message 落在第 1 行 —— 这就是「塌下去」的结果。 */
    var H = [
      { k: 0, row: 0, role: "user", text: "读一下 README" },
      { k: 1, row: 1, role: "assistant", text: "我去读这个文件" },
      { k: 2, row: 2, role: "tool", text: "84 行" },
      { k: 3, row: 1, role: "user", text: "继续" }
    ];
    for (var j = 0; j < H.length; j++) {
      var hy = LG.topY + H[j].row * LG.rowH + 11;
      s.push('<g data-h' + H[j].k + ' opacity="0">');
      s.push(
        '<text class="d-lg__role" x="300" y="' + hy + '">' + H[j].role + "</text>"
      );
      s.push(
        '<text class="d-lg__msg" x="356" y="' + hy + '">' + H[j].text + "</text>"
      );
      s.push("</g>");
    }

    s.push('<g data-sum opacity="0">');
    s.push(
      '<rect class="d-lg__sum" x="300" y="62" width="236" height="17" rx="2"/>'
    );
    s.push(
      '<text class="d-lg__sumt" x="310" y="73.5">摘要 · 遮蔽 seq 0…4</text>'
    );
    s.push("</g>");

    /* 从「写了一条 replace」指向「历史塌了」的因果线 */
    s.push(
      '<path class="d-lg__link" data-link d="M252 181 H276 V70 H300" opacity="0"/>'
    );

    s.push(
      '<text class="d-lg__note" data-note x="26" y="228" opacity="0">被遮蔽的 5 条仍在日志里 —— 消失只发生在视图里</text>'
    );

    s.push("</svg>");

    var host = document.createElement("div");
    host.innerHTML = s.join("");
    var svg = host.firstChild;
    root.appendChild(svg);

    var lRows = [];
    var hRows = [];
    for (var a = 0; a < 8; a++) lRows.push(svg.querySelector("[data-l" + a + "]"));
    for (var b = 0; b < 4; b++) hRows.push(svg.querySelector("[data-h" + b + "]"));
    var band = svg.querySelector("[data-band]");
    var sumEl = svg.querySelector("[data-sum]");
    var link = svg.querySelector("[data-link]");
    var note = svg.querySelector("[data-note]");

    /* 每条事件的写入时刻。右列消息跟它所依赖的那条事件同时出现 ——
       这是这张图的核心对应关系，别为了「错开更好看」而上错峰。 */
    var AT = [0.1, 0.24, 0.3, 0.36, 0.42, 0.52, 0.66, 0.86];
    var H_AT = [0.1, 0.3, 0.42, 0.86];

    function paint(t) {
      var i, k;

      /* 左列：逐条写入，刚写完的那条亮一下 */
      for (i = 0; i < 8; i++) {
        k = clamp((t - AT[i]) / 0.06, 0, 1);
        var dim = i <= 4 && t > 0.8 ? 0.45 : 1;
        lRows[i].setAttribute("opacity", (k * dim).toFixed(2));
        var live = t >= AT[i] && t < AT[i] + 0.09;
        svg
          .querySelector("[data-le" + i + "]")
          .setAttribute("class", "d-lg__e" + (live ? " is-live" : ""));
      }

      /* 右列：先出现，再在 replace 时塌掉 */
      /* 塌缩先结束、摘要再出现：两段重叠时，正在淡出的那行会透在摘要框里，
         看起来像文字叠字，而不是「被替换」。 */
      var col = clamp((t - 0.72) / 0.07, 0, 1);
      for (i = 0; i < 4; i++) {
        var on = clamp((t - H_AT[i]) / 0.06, 0, 1);
        var gone = i < 3 ? col : 0;
        hRows[i].setAttribute("opacity", (on * (1 - gone)).toFixed(2));
        hRows[i].setAttribute("transform", "translate(0," + (-6 * gone).toFixed(1) + ")");
      }

      var sp = clamp((t - 0.795) / 0.055, 0, 1);
      sumEl.setAttribute("opacity", sp.toFixed(2));

      band.setAttribute("opacity", (0.34 * clamp((t - 0.56) / 0.05, 0, 1)).toFixed(2));
      link.setAttribute(
        "opacity",
        (
          clamp((t - 0.7) / 0.06, 0, 1) * (1 - clamp((t - 0.86) / 0.06, 0, 1))
        ).toFixed(2)
      );
      note.setAttribute("opacity", clamp((t - 0.8) / 0.06, 0, 1).toFixed(2));

      if (t < 0.1) return 0;
      if (t < 0.24) return 1;
      if (t < 0.52) return 2;
      if (t < 0.66) return 3;
      if (t < 0.86) return 4;
      return 5;
    }

    return {
      paint: paint,
      phases: 6,
      text: function (i) {
        return LG.text[clamp(i, 0, 5)];
      },
      jump: function (k) {
        return clamp((clamp(k, 0, 5) + 0.5) / 6, 0, 1);
      },
      stepMarks: [0.1, 0.24, 0.52, 0.66, 0.86],
      marks: []
    };
  }

  /* ==========================================================================
     图 5 —— 能力缝的接线
     形态：中间一块 ctx 总线，左 Provider、右 Consumer，三条相位把线接通，
     最后换掉左边的实现 —— 线和右边的工具纹丝不动。
     讲的是「约定的键不换，换的只是背后的实现」。
     ========================================================================== */

  var SM = {
    text: [
      "<b>中间是 ctx</b> —— 所有插件共享的一块总线。现在它上面什么都没有。",
      "<b>① 装载 dsh-bash-local。</b>它是 Service Provider：把自己注册成 <code>ctx.shell</code>。总线上从此有了这个键。",
      "<b>② 装载 dsh-tool-bash。</b>它声明 <code>inject: ['shell']</code> —— 服务还没就位，它的装载就挂在这里等。",
      "<b>③ 服务到位，接线完成。</b>模型由此看到一个叫 <code>bash</code> 的工具。它不知道、也不需要知道底下是谁在执行。",
      "<b>④ 换实现：</b>卸掉 bash-local，装上 bash-sandbox。<code>ctx.shell</code> 还是那个键，<code>bash</code> 的 schema 一个字没变。"
    ]
  };

  function buildSeam(root) {
    var s = [];

    s.push(
      '<svg viewBox="0 0 560 224" role="img" aria-label="Service Provider 把自己注册成 ctx.shell，Consumer 声明 inject 等它就位；换实现时两者都不用动">'
    );

    /* 中间：ctx 总线与服务键 */
    s.push('<text class="d-sm__bus" x="170" y="20">ctx</text>');
    s.push('<g data-key opacity="0">');
    s.push('<rect class="d-sm__key" x="170" y="30" width="220" height="26" rx="2"/>');
    s.push('<text class="d-sm__keyt" x="184" y="47">ctx.shell</text>');
    s.push(
      '<text class="d-sm__keys" x="378" y="47" text-anchor="end">ShellExecutor</text>'
    );
    s.push("</g>");

    /* 左：Provider */
    s.push('<g data-pv opacity="0">');
    s.push('<rect class="d-sm__box" x="24" y="88" width="206" height="48" rx="2"/>');
    s.push('<text class="d-sm__k" x="38" y="106">PROVIDER</text>');
    s.push('<text class="d-sm__n" data-pv-local x="38" y="121">dsh-bash-local</text>');
    s.push('<text class="d-sm__n" data-pv-sandbox x="38" y="121" opacity="0">dsh-bash-sandbox</text>');
    s.push('<text class="d-sm__d" data-pvd x="38" y="131" opacity="0">本地子进程执行</text>');
    s.push("</g>");

    /* 右：Consumer */
    s.push('<g data-cs opacity="0">');
    s.push('<rect class="d-sm__box" x="330" y="88" width="206" height="48" rx="2"/>');
    s.push('<text class="d-sm__k" x="344" y="106">CONSUMER</text>');
    s.push('<text class="d-sm__n" x="344" y="121">dsh-tool-bash</text>');
    s.push(
      '<text class="d-sm__d" data-csd x="344" y="131" opacity="0">inject: [\'shell\']</text>'
    );
    s.push("</g>");

    /* 接线：左上→键，键→右上。虚线段表示挂起等待。 */
    s.push('<path class="d-sm__wire" data-wp d="M127 88 V43 H170" opacity="0"/>');
    s.push('<path class="d-sm__wire is-wait" data-wc d="M433 88 V43 H390" opacity="0"/>');
    s.push(
      '<text class="d-sm__wait" data-wait x="447" y="76" opacity="0">fiber 挂起，等服务出现</text>'
    );

    /* 模型看到的东西 */
    s.push('<g data-tool opacity="0">');
    s.push('<rect class="d-sm__tool" x="330" y="164" width="206" height="26" rx="2"/>');
    s.push('<text class="d-sm__keyt" x="344" y="181">bash</text>');
    s.push(
      '<text class="d-sm__keys" x="522" y="181" text-anchor="end">模型的工具 schema</text>'
    );
    s.push("</g>");

    /* 换实现时的一行注 */
    s.push(
      '<text class="d-sm__note" data-note x="24" y="206" opacity="0">实现换了，约定的键和模型看到的 schema 都没动</text>'
    );

    s.push("</svg>");

    var host = document.createElement("div");
    host.innerHTML = s.join("");
    var svg = host.firstChild;
    root.appendChild(svg);

    var keyEl = svg.querySelector("[data-key]");
    var pvEl = svg.querySelector("[data-pv]");
    var csEl = svg.querySelector("[data-cs]");
    var pvLocal = svg.querySelector("[data-pv-local]");
    var pvSandbox = svg.querySelector("[data-pv-sandbox]");
    var wp = svg.querySelector("[data-wp]");
    var wc = svg.querySelector("[data-wc]");
    var wait = svg.querySelector("[data-wait]");
    var csd = svg.querySelector("[data-csd]");
    var pvd = svg.querySelector("[data-pvd]");
    var toolEl = svg.querySelector("[data-tool]");
    var note = svg.querySelector("[data-note]");

    function paint(t) {
      var k;
      var reg = clamp((t - 0.22) / 0.08, 0, 1); // 注册完成 → 键出现
      keyEl.setAttribute("opacity", reg.toFixed(2));

      k = clamp((t - 0.1) / 0.12, 0, 1);
      pvEl.setAttribute("opacity", k.toFixed(2));
      pvEl.setAttribute("transform", "translate(0," + (8 * (1 - k)).toFixed(1) + ")");

      wp.setAttribute("opacity", clamp((t - 0.2) / 0.1, 0, 1).toFixed(2));

      k = clamp((t - 0.32) / 0.12, 0, 1);
      csEl.setAttribute("opacity", k.toFixed(2));
      csEl.setAttribute("transform", "translate(0," + (8 * (1 - k)).toFixed(1) + ")");

      wc.setAttribute("opacity", clamp((t - 0.42) / 0.08, 0, 1).toFixed(2));
      /* 两侧的说明行跟各自的接线同时出现；换实现时说明跟着名字一起切 */
      var dOn = clamp((t - 0.44) / 0.08, 0, 1);
      csd.setAttribute("opacity", dOn.toFixed(2));
      pvd.setAttribute("opacity", dOn.toFixed(2));
      wait.setAttribute(
        "opacity",
        (clamp((t - 0.48) / 0.06, 0, 1) * (1 - clamp((t - 0.62) / 0.06, 0, 1))).toFixed(2)
      );

      /* 接通：虚线换实线（换 class），工具浮出 */
      var conn = clamp((t - 0.62) / 0.08, 0, 1);
      wc.setAttribute("class", "d-sm__wire" + (conn > 0.5 ? "" : " is-wait"));
      k = clamp((t - 0.66) / 0.1, 0, 1);
      toolEl.setAttribute("opacity", k.toFixed(2));
      toolEl.setAttribute(
        "transform",
        "translate(0," + (6 * (1 - k)).toFixed(1) + ")"
      );

      /* 换实现：名字交叉淡切，其余不动 */
      var out = clamp((t - 0.8) / 0.07, 0, 1);
      var inn = clamp((t - 0.87) / 0.07, 0, 1);
      pvLocal.setAttribute("opacity", (1 - out).toFixed(2));
      pvSandbox.setAttribute("opacity", inn.toFixed(2));
      pvd.textContent = inn > 0.5 ? "每条命令经 ctx.sandbox" : "本地子进程执行";
      note.setAttribute("opacity", clamp((t - 0.9) / 0.06, 0, 1).toFixed(2));

      if (t < 0.1) return 0;
      if (t < 0.32) return 1;
      if (t < 0.62) return 2;
      if (t < 0.8) return 3;
      return 4;
    }

    return {
      paint: paint,
      phases: 5,
      text: function (i) {
        return SM.text[clamp(i, 0, 4)];
      },
      jump: function (k) {
        return clamp((clamp(k, 0, 4) + 0.5) / 5, 0, 1);
      },
      stepMarks: [0.1, 0.32, 0.62, 0.8],
      marks: []
    };
  }

  /* ==========================================================================
     图 6 —— 一个批次怎么排
     形态：甘特图。五条调用各占一条泳道，横向是时间，纵向是身份。
     讲的是「派发可以重叠，顺序不能乱」：上半部分允许重叠，
     下半部分的回填槽仍然按 ①②③④⑤ 走 —— 两条轴各管一件事。
     ========================================================================== */

  var BT = {
    x0: 124, // 时间轨道左端
    x1: 548, // 右端
    laneTop: 34, // 第一条泳道的顶
    laneH: 28,
    barH: 14,
    resY: 190,
    /* s/e 是轨道上的起止（0..1），a0/a1 是动画时间轴上的出现窗口。
       两者刻意不同：起止决定图长什么样，出现窗口决定它什么时候被看见。 */
    calls: [
      { n: "①", name: "read_file", s: 0.02, e: 0.3, ex: false, a0: 0.1, a1: 0.24 },
      { n: "②", name: "grep", s: 0.06, e: 0.22, ex: false, a0: 0.13, a1: 0.21 },
      { n: "③", name: "read_file", s: 0.22, e: 0.4, ex: false, a0: 0.21, a1: 0.31 },
      { n: "④", name: "apply_patch", s: 0.44, e: 0.68, ex: true, a0: 0.37, a1: 0.5 },
      { n: "⑤", name: "bash", s: 0.72, e: 0.9, ex: false, a0: 0.55, a1: 0.64 }
    ],
    /* 回填时刻：按模型顺序，一个接一个 */
    resAt: [0.74, 0.79, 0.84, 0.89, 0.94],
    text: [
      "<b>模型一次吐出五个调用。</b>它们作为一批交给执行器 —— 顺序是模型写的顺序，不是能并发的顺序。",
      "<b>①②③ 同一组，池子只有两个位子。</b>② 结束，③ 才被放进池子。这是有界滚动池，不是「全都同时跑」。",
      "<b>④ 是独占调用，它前后都是屏障。</b>前面三个全部结算它才开始；它没结束，后面的谁也不能开始。",
      "<b>⑤ 在屏障之后重新计位。</b>派发在时钟上重叠，可策略、结果、结果上下文永远按模型的顺序走。",
      "<b>回填仍是 ①②③④⑤。</b>② 最早完成，却排在第二位 —— 模型看到的是顺序，看不见并发。"
    ]
  };

  function buildBatch(root) {
    var s = [];
    var span = BT.x1 - BT.x0;
    var i, k;

    function X(u) {
      return BT.x0 + u * span;
    }

    s.push(
      '<svg viewBox="0 0 560 216" role="img" aria-label="一个批次里的五个工具调用：三个并行共享两个位子，一个独占形成屏障，结果仍按模型发出的顺序回填">'
    );

    /* 顶部两组的关系标注。数字是算出来的，不是摆上去的 ——
       括号的起止与下面那些条的起止用同一组 s / e，改条就改括号。 */
    var gA = { x1: X(0.02), x2: X(0.4) };
    var gB = { x1: X(0.44), x2: X(0.68) };

    s.push('<g data-grp-a opacity="0">');
    s.push(
      '<path class="d-bt__brk" d="M' +
        gA.x1.toFixed(1) +
        ' 27 V 23 H' +
        gA.x2.toFixed(1) +
        ' V 27"/>'
    );
    s.push(
      '<text class="d-bt__grp" x="' +
        ((gA.x1 + gA.x2) / 2).toFixed(1) +
        '" y="19" text-anchor="middle">parallel · 同组 3 个，池 2</text>'
    );
    s.push("</g>");

    s.push('<g data-grp-b opacity="0">');
    s.push(
      '<path class="d-bt__brk" d="M' +
        gB.x1.toFixed(1) +
        ' 27 V 23 H' +
        gB.x2.toFixed(1) +
        ' V 27"/>'
    );
    s.push(
      '<text class="d-bt__grp" x="' +
        ((gB.x1 + gB.x2) / 2).toFixed(1) +
        '" y="19" text-anchor="middle">exclusive · 独占</text>'
    );
    s.push("</g>");

    /* 泳道：一条一条的浅线，只是让人对得上行，不承担别的意义 */
    for (i = 0; i <= BT.calls.length; i++) {
      s.push(
        '<line class="d-bt__lane" x1="' +
          BT.x0 +
          '" y1="' +
          (BT.laneTop + i * BT.laneH - 4) +
          '" x2="' +
          BT.x1 +
          '" y2="' +
          (BT.laneTop + i * BT.laneH - 4) +
          '"/>'
      );
    }

    /* 左侧身份列 */
    for (k = 0; k < BT.calls.length; k++) {
      var ly = BT.laneTop + k * BT.laneH;
      s.push(
        '<text class="d-bt__idx" x="14" y="' + (ly + 10.5) + '">' + BT.calls[k].n + "</text>"
      );
      s.push(
        '<text class="d-bt__name" x="28" y="' + (ly + 10.5) + '">' + BT.calls[k].name + "</text>"
      );
    }

    /* 屏障：两条虚线穿过所有泳道。独占调用靠它表达「前后都等它」。 */
    s.push('<g data-barrier opacity="0">');
    [BT.calls[3].s, BT.calls[3].e].forEach(function (u) {
      s.push(
        '<line class="d-bt__barrier" x1="' +
          X(u).toFixed(1) +
          '" y1="29" x2="' +
          X(u).toFixed(1) +
          '" y2="' +
          (BT.laneTop + BT.calls.length * BT.laneH - 6) +
          '"/>'
      );
    });
    s.push("</g>");

    /* 五条调用 */
    for (k = 0; k < BT.calls.length; k++) {
      var c = BT.calls[k];
      var by = BT.laneTop + k * BT.laneH;
      s.push('<g data-bar' + k + ' opacity="0">');
      s.push(
        '<rect class="d-bt__bar' +
          (c.ex ? " is-ex" : "") +
          '" data-br' +
          k +
          ' x="' +
          X(c.s).toFixed(1) +
          '" y="' +
          by +
          '" width="0" height="' +
          BT.barH +
          '" rx="1"/>'
      );
      /* 完成刻：条尾那一道 2px。谁先完成，图上看得见。 */
      s.push(
        '<rect class="d-bt__cap' +
          (c.ex ? " is-ex" : "") +
          '" data-cap' +
          k +
          '="0" y="' +
          (by + 3) +
          '" width="2" height="' +
          (BT.barH - 6) +
          '" opacity="0"/>'
      );
      s.push("</g>");
    }

    /* 时间轴。不标数字：这些时长是示意，标了反而像真的。 */
    s.push(
      '<line class="d-bt__axis" x1="' + BT.x0 + '" y1="178" x2="' + BT.x1 + '" y2="178"/>'
    );
    for (i = 0; i <= 4; i++) {
      var tx = BT.x0 + (i * span) / 4;
      s.push(
        '<line class="d-bt__tick" x1="' +
          tx.toFixed(1) +
          '" y1="178" x2="' +
          tx.toFixed(1) +
          '" y2="182"/>'
      );
    }
    s.push('<text class="d-bt__grp" x="548" y="172" text-anchor="end">时间 →</text>');

    /* 回填槽：按模型顺序，固定五个位置 */
    s.push('<text class="d-bt__idx" x="14" y="202">回填</text>');
    for (k = 0; k < 5; k++) {
      s.push(
        '<rect class="d-bt__res" data-res' +
          k +
          ' x="' +
          (BT.x0 + k * 40) +
          '" y="' +
          BT.resY +
          '" width="34" height="18" rx="2"/>'
      );
      s.push(
        '<text class="d-bt__resn" data-resn' +
          k +
          ' x="' +
          (BT.x0 + k * 40 + 17) +
          '" y="' +
          (BT.resY + 12.5) +
          '" text-anchor="middle">' +
          BT.calls[k].n +
          "</text>"
      );
    }
    s.push(
      '<text class="d-bt__grp" x="' +
        (BT.x0 + 208) +
        '" y="202">序号 = 模型顺序</text>'
    );

    s.push("</svg>");

    var host = document.createElement("div");
    host.innerHTML = s.join("");
    var svg = host.firstChild;
    root.appendChild(svg);

    var bars = [];
    var caps = [];
    var wraps = [];
    for (k = 0; k < BT.calls.length; k++) {
      bars.push(svg.querySelector("[data-br" + k + "]"));
      caps.push(svg.querySelector("[data-cap" + k + "]"));
      wraps.push(svg.querySelector("[data-bar" + k + "]"));
    }
    var resEls = [];
    var resnEls = [];
    for (k = 0; k < 5; k++) {
      resEls.push(svg.querySelector("[data-res" + k + "]"));
      resnEls.push(svg.querySelector("[data-resn" + k + "]"));
    }
    var grpA = svg.querySelector("[data-grp-a]");
    var grpB = svg.querySelector("[data-grp-b]");
    var barrier = svg.querySelector("[data-barrier]");

    function paint(t) {
      var j, c, p, w, full;

      for (j = 0; j < BT.calls.length; j++) {
        c = BT.calls[j];
        p = clamp((t - c.a0) / (c.a1 - c.a0), 0, 1);
        wraps[j].setAttribute("opacity", p > 0 ? "1" : "0");
        full = X(c.e) - X(c.s);
        w = full * easeOut(p);
        /* 宽度小于 1px 时 rect 会画成一条脏边，干脆不给宽度 */
        bars[j].setAttribute("width", w < 1 ? "0" : w.toFixed(1));
        /* 完成刻：条走满才算完成，只亮一次，不来回闪 */
        caps[j].setAttribute("opacity", p >= 1 ? "1" : "0");
        caps[j].setAttribute("x", (X(c.e) - 2).toFixed(1));
      }

      grpA.setAttribute("opacity", clamp((t - 0.08) / 0.05, 0, 1).toFixed(2));
      grpB.setAttribute("opacity", clamp((t - 0.33) / 0.05, 0, 1).toFixed(2));
      barrier.setAttribute("opacity", clamp((t - 0.32) / 0.06, 0, 1).toFixed(2));

      for (j = 0; j < 5; j++) {
        var on = t >= BT.resAt[j];
        resEls[j].setAttribute("class", "d-bt__res" + (on ? " is-on" : ""));
        resnEls[j].setAttribute("class", "d-bt__resn" + (on ? " is-on" : ""));
      }

      if (t < 0.1) return 0;
      if (t < 0.34) return 1;
      if (t < 0.52) return 2;
      if (t < 0.72) return 3;
      return 4;
    }

    return {
      paint: paint,
      phases: 5,
      text: function (i) {
        return BT.text[clamp(i, 0, 4)];
      },
      jump: function (k) {
        return clamp((clamp(k, 0, 4) + 0.5) / 5, 0, 1);
      },
      stepMarks: [0.1, 0.34, 0.52, 0.72],
      marks: []
    };
  }

  /* ==========================================================================
     图 7 —— 一个 profile 是一叠补丁
     形态：左边四张纸片按序叠下，右边合并结果逐行长出。
     讲的是「配置不是一份文件」：同一条条目，后层的 config 整条替换前层。
     所以最后一层落下时，右边不增加行 —— 只把某个值换掉。
     ========================================================================== */

  var LY = {
    sheetX: 16,
    sheetY: 22,
    sheetW: 190,
    sheetH: 30,
    sheetGap: 34,
    rowX: 300,
    rowW: 200,
    rowY: 22,
    rowH: 22,
    rowGap: 24,
    sheets: [
      { n: "bundle/base", s: "共享核心" },
      { n: "bundle/web-app", s: "模式层" },
      { n: "profiles/web", s: "你的 profile patch" },
      { n: "cordis.patch.yml", s: "home 级 · 最后应用" }
    ],
    /* 每行属于哪一层：值是它出现的层号 */
    rows: [
      { id: "llm", at: 0 },
      { id: "tools", at: 0 },
      { id: "agent-loop", at: 0 },
      { id: "webserver", at: 1 },
      { id: "settings", at: 2 },
      { id: "sandbox-policy", at: 0, swap: true }
    ],
    /* 四层落下的时刻 */
    at: [0.12, 0.34, 0.56, 0.74],
    text: [
      "<b>一个 profile 不是一份文件。</b>它是四份 patch 文档按固定顺序叠出来的结果 —— 顺序就是优先级。",
      "<b>bundle/base 先落地。</b>模型、工具、循环这些共享核心都在这一层，每个随附 profile 都用它当底。",
      "<b>再叠模式层。</b>web-app 只加「怎么用人」的部分：服务器、连接。换 profile 基本就是换这一层。",
      "<b>然后是 profile 自己的 patch。</b>它随安装走、不在包里 —— 所以升级覆盖不到你的改动。",
      "<b>最后是 home 级 patch，优先级最高。</b>看 sandbox-policy 那一行：行没多一条，配置被整条换掉了。"
    ]
  };

  function buildLayer(root) {
    var s = [];
    var i, k;

    s.push(
      '<svg viewBox="0 0 560 190" role="img" aria-label="四层 patch 文档依次叠放：bundle/base、模式层、profile 自己的 patch、home 级 patch；右侧是合并结果，最后一层不增加行，只替换某一行的配置">'
    );

    /* 左：四张纸片 */
    for (i = 0; i < LY.sheets.length; i++) {
      var sx = LY.sheetX + i * 5;
      var sy = LY.sheetY + i * LY.sheetGap;
      s.push('<g data-sh' + i + ' opacity="0">');
      s.push(
        '<rect class="d-ly__sheet' +
          (i === 3 ? " is-top" : "") +
          '" x="' +
          sx +
          '" y="' +
          sy +
          '" width="' +
          LY.sheetW +
          '" height="' +
          LY.sheetH +
          '" rx="2"/>'
      );
      s.push(
        '<text class="d-ly__n" x="' + (sx + 12) + '" y="' + (sy + 13) + '">' +
          LY.sheets[i].n +
          "</text>"
      );
      s.push(
        '<text class="d-ly__s" x="' + (sx + 12) + '" y="' + (sy + 25) + '">' +
          LY.sheets[i].s +
          "</text>"
      );
      s.push(
        '<text class="d-ly__s" x="' +
          (sx + LY.sheetW - 10) +
          '" y="' +
          (sy + 13) +
          '" text-anchor="end">' +
          (i + 1) +
          "</text>"
      );
      s.push("</g>");
    }

    /* 中间：合并箭头 */
    s.push('<g data-arw opacity="0">');
    s.push('<path class="d-ly__arw" d="M228 94 H280"/>');
    s.push('<path class="d-ly__arw" d="M274 90 L281 94 L274 98"/>');
    s.push('<text class="d-ly__cap" x="254" y="84" text-anchor="middle">按序合并</text>');
    s.push("</g>");

    /* 右：合并结果。行不按层分组，因为结果里根本不保留来源 —— 只有一条条条目。 */
    for (k = 0; k < LY.rows.length; k++) {
      var ry = LY.rowY + k * LY.rowGap;
      s.push('<g data-row' + k + ' opacity="0">');
      s.push(
        '<rect class="d-ly__row" data-rb' +
          k +
          ' x="' +
          LY.rowX +
          '" y="' +
          ry +
          '" width="' +
          LY.rowW +
          '" height="' +
          LY.rowH +
          '" rx="2"/>'
      );
      s.push(
        '<text class="d-ly__id" x="' + (LY.rowX + 10) + '" y="' + (ry + 14) + '">' +
          LY.rows[k].id +
          "</text>"
      );
      s.push("</g>");
    }

    /* 被替换的那个值：两个文本交叉淡切，位置不动 */
    var swapY = LY.rowY + 5 * LY.rowGap + 14;
    var vx = LY.rowX + LY.rowW - 8;
    s.push(
      '<text class="d-ly__v" data-v1 x="' + vx + '" y="' + swapY + '" text-anchor="end" opacity="0">workspace-write</text>'
    );
    s.push(
      '<text class="d-ly__v is-new" data-v2 x="' + vx + '" y="' + swapY + '" text-anchor="end" opacity="0">danger-full-access</text>'
    );

    s.push("</svg>");

    var host = document.createElement("div");
    host.innerHTML = s.join("");
    var svg = host.firstChild;
    root.appendChild(svg);

    var sheetEls = [];
    var rowEls = [];
    var rowBgs = [];
    for (i = 0; i < LY.sheets.length; i++) sheetEls.push(svg.querySelector("[data-sh" + i + "]"));
    for (k = 0; k < LY.rows.length; k++) {
      rowEls.push(svg.querySelector("[data-row" + k + "]"));
      rowBgs.push(svg.querySelector("[data-rb" + k + "]"));
    }
    var arw = svg.querySelector("[data-arw]");
    var v1 = svg.querySelector("[data-v1]");
    var v2 = svg.querySelector("[data-v2]");

    function paint(t) {
      var j, c, p;

      /* 纸片：落下（位移 + 淡入）。错开 8px，让「叠」这个动作看得见。 */
      for (j = 0; j < LY.sheets.length; j++) {
        c = LY.at[j];
        p = clamp((t - c) / 0.09, 0, 1);
        sheetEls[j].setAttribute("opacity", p.toFixed(2));
        sheetEls[j].setAttribute("transform", "translate(0," + (-8 * (1 - easeOut(p))).toFixed(1) + ")");
      }

      /* 行：属于哪一层，就在那层落地之后出现 */
      for (k = 0; k < LY.rows.length; k++) {
        var born = LY.at[LY.rows[k].at] + 0.05;
        p = clamp((t - born) / 0.06, 0, 1);
        rowEls[k].setAttribute("opacity", p.toFixed(2));
        rowEls[k].setAttribute("transform", "translate(" + (6 * (1 - easeOut(p))).toFixed(1) + ",0)");
      }

      arw.setAttribute("opacity", clamp((t - 0.1) / 0.06, 0, 1).toFixed(2));

      /* 最后一层不增行，只改值。这就是「替换」的全部可视化。 */
      /* 值属于它那一行：行还没出现，值也不能先飘在那儿 */
      var sw = clamp((t - 0.8) / 0.07, 0, 1);
      var rowOn = clamp((t - LY.at[0] - 0.05) / 0.06, 0, 1);
      v1.setAttribute("opacity", (rowOn * (1 - sw)).toFixed(2));
      v2.setAttribute("opacity", (rowOn * sw).toFixed(2));
      rowBgs[5].setAttribute("class", "d-ly__row" + (sw > 0.5 ? " is-swap" : ""));

      if (t < LY.at[0]) return 0;
      if (t < LY.at[1]) return 1;
      if (t < LY.at[2]) return 2;
      if (t < LY.at[3]) return 3;
      return 4;
    }

    return {
      paint: paint,
      phases: 5,
      text: function (i) {
        return LY.text[clamp(i, 0, 4)];
      },
      jump: function (k) {
        return clamp((clamp(k, 0, 4) + 0.5) / 5, 0, 1);
      },
      stepMarks: [LY.at[0], LY.at[1], LY.at[2], LY.at[3]],
      marks: []
    };
  }

  /* ==========================================================================
     播放器
     ========================================================================== */

  function Player(root, builder, opts) {
    var stage = root.querySelector("[data-stage]");
    var readout = root.querySelector("[data-readout]");
    var timeEl = root.querySelector("[data-time]");
    var playBtn = root.querySelector("[data-play]");
    var scrub = root.querySelector("[data-scrub]");
    var fill = root.querySelector("[data-fill]");
    var knob = root.querySelector("[data-knob]");
    var live = root.querySelector("[data-live]");
    var speedBtns = root.querySelectorAll("[data-speed]");

    /* 四角标记 */
    ["tl", "tr", "bl", "br"].forEach(function (p) {
      var d = document.createElement("i");
      d.className = "scope__corner scope__corner--" + p;
      stage.appendChild(d);
    });

    var fig = builder(stage);

    /* 有 step 分界的图，在进度条上打出刻线。
       没有这组刻线，点 STEP 2 时填充停在 42%，读者会以为没对齐。 */
    var segHost = root.querySelector("[data-segs]");
    if (segHost && fig.stepMarks) {
      fig.stepMarks.forEach(function (v) {
        var el = document.createElement("i");
        el.style.left = (v * 100).toFixed(2) + "%";
        segHost.appendChild(el);
      });
    }

    var duration = opts.duration;
    var t = REDUCE ? 1 : 0;
    var playing = false;
    var speed = 1;
    var raf = null;
    var last = 0;
    var touched = false;
    var lastPhase = -1;

    /* 设计走查用：?freeze=0.42 冻结在 42% 处 */
    var fz = new URLSearchParams(location.search).get("freeze");
    if (fz !== null && fz !== "" && !isNaN(+fz)) {
      t = clamp(+fz, 0, 1);
      touched = true;
    }

    /* 节点可点：跳到该节点对应的时刻 */
    if (fig.marks.length) {
      fig.marks.forEach(function (m) {
        var hit = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        hit.setAttribute("cx", m.x);
        hit.setAttribute("cy", m.y);
        hit.setAttribute("r", 16);
        hit.setAttribute("fill", "transparent");
        hit.style.cursor = "pointer";
        hit.addEventListener("click", function () {
          touched = true;
          pause();
          setT(m.jump);
        });
        stage.querySelector("svg").appendChild(hit);
      });
    }

    function setT(v) {
      t = clamp(v, 0, 1);
      apply();
    }

    function apply() {
      var phase = fig.paint(t);
      if (phase !== lastPhase) {
        readout.innerHTML = fig.text(phase);
        /* 重触发一次淡入，避免文案是「跳」过去的 */
        readout.classList.remove("is-swap");
        void readout.offsetWidth;
        readout.classList.add("is-swap");
        lastPhase = phase;
      }
      var pct = (t * 100).toFixed(2) + "%";
      if (fill) fill.style.width = pct;
      if (knob) knob.style.left = pct;
      if (scrub) scrub.value = String(Math.round(t * 1000));
      if (timeEl) {
        var totalSec = duration / 1000;
        timeEl.textContent = fmt(t * totalSec) + " / " + fmt(totalSec);
      }
    }

    function loop(now) {
      if (!playing) return;
      var dt = now - last;
      last = now;
      if (dt > 120) dt = 120;

      t += (dt / duration) * speed;

      if (t >= 1) {
        /* 尾帧停一拍再回到首帧，避免刚看懂就跳走 */
        t = 1;
        apply();
        playing = false;
        syncBtn();
        setTimeout(function () {
          if (playing || touched) return;
          t = 0;
          apply();
          play();
        }, 1100);
        return;
      }

      apply();
      raf = requestAnimationFrame(loop);
    }

    function play() {
      if (playing) return;
      /* 停在末帧时再点播放，要能从头重来，否则按下去毫无反应 */
      if (t >= 0.999) {
        t = 0;
        apply();
      }
      playing = true;
      last = performance.now();
      syncBtn();
      raf = requestAnimationFrame(loop);
    }

    function pause() {
      playing = false;
      if (raf) cancelAnimationFrame(raf);
      raf = null;
      syncBtn();
    }

    function syncBtn() {
      if (playBtn) {
        playBtn.dataset.state = playing ? "playing" : "paused";
        playBtn.setAttribute("aria-pressed", String(playing));
        playBtn.setAttribute("aria-label", playing ? "暂停动画" : "播放动画");
      }
      if (live) {
        live.classList.toggle("is-paused", !playing);
        var lt = live.querySelector("span");
        if (lt) lt.textContent = playing ? "running" : "paused";
      }
    }

    if (playBtn) {
      playBtn.addEventListener("click", function () {
        touched = true;
        if (playing) pause();
        else play();
      });
    }

    if (scrub) {
      scrub.addEventListener("input", function () {
        touched = true;
        pause();
        setT(+scrub.value / 1000);
      });
    }

    Array.prototype.forEach.call(speedBtns, function (b) {
      b.addEventListener("click", function () {
        speed = +b.dataset.speed;
        Array.prototype.forEach.call(speedBtns, function (o) {
          o.setAttribute("aria-pressed", String(o === b));
        });
      });
    });

    /* 空格：交给全局仲裁，避免两个图同时在视口里时一起被切 */
    var inView = false;
    PLAYERS.push({
      el: root,
      toggle: function () {
        touched = true;
        if (playing) pause();
        else play();
      }
    });

    apply();
    syncBtn();

    if (!REDUCE && "IntersectionObserver" in window) {
      new IntersectionObserver(
        function (es) {
          es.forEach(function (en) {
            inView = en.isIntersecting;
            if (en.isIntersecting) {
              if (!touched) play();
            } else if (playing) {
              pause();
            }
          });
        },
        { threshold: 0.4 }
      ).observe(root);
    } else {
      inView = true;
    }

    return { play: play, pause: pause };
  }

  /* ---------- 启动 ---------- */

  var DUR = { step: 11000, turn: 15000, boundary: 12000, log: 14000, seam: 12000, batch: 13000, layer: 12000 };

  document.addEventListener("DOMContentLoaded", function () {
    Array.prototype.forEach.call(
      document.querySelectorAll("[data-figure]"),
      function (root) {
        var kind = root.dataset.figure;
        var builder =
          kind === "step"
            ? buildStep
            : kind === "turn"
            ? buildTurn
            : kind === "boundary"
            ? buildBoundary
            : kind === "log"
            ? buildLog
            : kind === "seam"
            ? buildSeam
            : kind === "batch"
            ? buildBatch
            : kind === "layer"
            ? buildLayer
            : null;
        if (builder) Player(root, builder, { duration: DUR[kind] });
      }
    );
  });
})();
