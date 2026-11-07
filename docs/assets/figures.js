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

  var DUR = { step: 11000, turn: 15000, boundary: 12000, log: 14000 };

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
            : null;
        if (builder) Player(root, builder, { duration: DUR[kind] });
      }
    );
  });
})();
