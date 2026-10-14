"use strict";
(() => {
  var __defProp = Object.defineProperty;
  var __defProps = Object.defineProperties;
  var __getOwnPropDescs = Object.getOwnPropertyDescriptors;
  var __getOwnPropSymbols = Object.getOwnPropertySymbols;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __propIsEnum = Object.prototype.propertyIsEnumerable;
  var __defNormalProp = (obj, key2, value) => key2 in obj ? __defProp(obj, key2, { enumerable: true, configurable: true, writable: true, value }) : obj[key2] = value;
  var __spreadValues = (a, b) => {
    for (var prop in b || (b = {}))
      if (__hasOwnProp.call(b, prop))
        __defNormalProp(a, prop, b[prop]);
    if (__getOwnPropSymbols)
      for (var prop of __getOwnPropSymbols(b)) {
        if (__propIsEnum.call(b, prop))
          __defNormalProp(a, prop, b[prop]);
      }
    return a;
  };
  var __spreadProps = (a, b) => __defProps(a, __getOwnPropDescs(b));

  // ../src/shared/uimotion/figma/fonts.ts
  var ROBLOX_FAMILIES = [
    "AccanthisADFStd",
    "AmaticSC",
    "Arimo",
    "Balthazar",
    "Bangers",
    "BuilderExtended",
    "BuilderMono",
    "BuilderSans",
    "ComicNeueAngular",
    "Creepster",
    "DenkOne",
    "Fondamento",
    "FredokaOne",
    "GothamSSm",
    "GrenzeGotisch",
    "Guru",
    "HighwayGothic",
    "Inconsolata",
    "IndieFlower",
    "JosefinSans",
    "Jura",
    "Kalam",
    "LegacyArial",
    "LuckiestGuy",
    "Merriweather",
    "Michroma",
    "Montserrat",
    "Nunito",
    "Oswald",
    "PatrickHand",
    "PermanentMarker",
    "PressStart2P",
    "Roboto",
    "RobotoCondensed",
    "RobotoMono",
    "RomanAntique",
    "Sarpanch",
    "SourceSansPro",
    "SpecialElite",
    "TitilliumWeb",
    "Ubuntu",
    "Zekton"
  ];
  var key = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  var EXACT = {};
  for (const f of ROBLOX_FAMILIES) EXACT[key(f)] = f;
  Object.assign(EXACT, {
    gotham: "GothamSSm",
    gothamssm: "GothamSSm",
    sourcesans3: "SourceSansPro",
    sourcesanspro: "SourceSansPro",
    fredoka: "FredokaOne",
    fredokaone: "FredokaOne",
    pressstart2p: "PressStart2P",
    buildersans: "BuilderSans",
    accanthisadfstd: "AccanthisADFStd"
  });
  var NEAR = {
    inter: "BuilderSans",
    sfpro: "BuilderSans",
    sfprodisplay: "BuilderSans",
    sfprotext: "BuilderSans",
    segoeui: "BuilderSans",
    helvetica: "Arimo",
    helveticaneue: "Arimo",
    arial: "Arimo",
    poppins: "Montserrat",
    manrope: "BuilderSans",
    dmsans: "BuilderSans",
    figtree: "BuilderSans",
    outfit: "Montserrat",
    plusjakartasans: "BuilderSans",
    lato: "SourceSansPro",
    opensans: "SourceSansPro",
    notosans: "SourceSansPro",
    ibmplexsans: "SourceSansPro",
    rubik: "Nunito",
    quicksand: "Nunito",
    varelaround: "Nunito",
    baloo2: "FredokaOne",
    baloo: "FredokaOne",
    chewy: "FredokaOne",
    lilitaone: "LuckiestGuy",
    titanone: "LuckiestGuy",
    bungee: "LuckiestGuy",
    anton: "Oswald",
    bebasneue: "Oswald",
    impact: "Oswald",
    barlowcondensed: "RobotoCondensed",
    barlow: "BuilderSans",
    orbitron: "Michroma",
    exo2: "TitilliumWeb",
    rajdhani: "Sarpanch",
    playfairdisplay: "Merriweather",
    georgia: "Merriweather",
    timesnewroman: "Merriweather",
    lora: "Merriweather",
    jetbrainsmono: "RobotoMono",
    firacode: "RobotoMono",
    sfmono: "RobotoMono",
    menlo: "RobotoMono",
    couriernew: "SpecialElite",
    comicneue: "ComicNeueAngular",
    comicsansms: "ComicNeueAngular"
  };
  var ROBLOX_WEIGHTS = [
    [100, "Thin"],
    [200, "ExtraLight"],
    [300, "Light"],
    [400, "Regular"],
    [500, "Medium"],
    [600, "SemiBold"],
    [700, "Bold"],
    [800, "ExtraBold"],
    [900, "Heavy"]
  ];
  function robloxWeight(weight) {
    const w = Number.isFinite(weight) ? Number(weight) : 400;
    let best = ROBLOX_WEIGHTS[3];
    for (const x of ROBLOX_WEIGHTS) if (Math.abs(x[0] - w) < Math.abs(best[0] - w)) best = x;
    return best[1];
  }
  function mapFont(family, weight, italic, postScript) {
    var _a;
    const fam = (family != null ? family : "").trim() || "Inter";
    const k = key(fam);
    let out = EXACT[k];
    let exact = !!out;
    let reason;
    if (!out) {
      out = (_a = NEAR[k]) != null ? _a : NEAR[key(fam.split(/\s+/)[0])];
      if (out) reason = `closest Roblox family to ${fam}`;
    }
    if (!out) {
      const generic = /mono|code|consol|courier/i.test(fam + (postScript != null ? postScript : "")) ? "RobotoMono" : /serif|garamond|times|roman|book|slab/i.test(fam) && !/sans/i.test(fam) ? "Merriweather" : /round|bubble|comic|cartoon/i.test(fam) ? "FredokaOne" : "BuilderSans";
      out = generic;
      reason = `${fam} is not a Roblox font; fallback ${generic}`;
    }
    exact = exact && !reason;
    const style = italic || /italic|oblique/i.test(postScript != null ? postScript : "") ? "Italic" : "Normal";
    return __spreadValues({ figma: fam, family: out, asset: `rbxasset://fonts/families/${out}.json`, weight: robloxWeight(weight), style, exact }, reason ? { reason } : {});
  }

  // ../src/shared/uimotion/figma/map.ts
  var VECTOR_TYPES = /* @__PURE__ */ new Set(["VECTOR", "BOOLEAN_OPERATION", "STAR", "LINE", "REGULAR_POLYGON", "POLYGON"]);
  var CONTAINER_TYPES = /* @__PURE__ */ new Set(["FRAME", "GROUP", "COMPONENT", "COMPONENT_SET", "INSTANCE", "SECTION", "RECTANGLE", "ELLIPSE"]);
  var BUTTON_RE = /(^|[^a-z])(button|btn|cta)([^a-z]|$)|Button|Btn/i;
  var r2 = (x) => Math.round(x * 100) / 100;
  var r4 = (x) => Math.round(x * 1e4) / 1e4;
  var px = (x) => Math.round(x);
  var clamp01 = (x) => Math.max(0, Math.min(1, x));
  var udim2 = (xs, xo, ys, yo) => ({ t: "UDim2", v: [r4(xs), px(xo), r4(ys), px(yo)] });
  var udim = (s, o) => ({ t: "UDim", v: [r4(s), px(o)] });
  var vec2 = (x, y) => ({ t: "Vector2", v: [r4(x), r4(y)] });
  var color3 = (c) => ({ t: "Color3", v: [r4(c.r), r4(c.g), r4(c.b)] });
  var enumv = (e, v) => ({ t: "Enum", e, v });
  function slug(name) {
    return String(name != null ? name : "").replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "image";
  }
  function instanceName(name) {
    const n = String(name != null ? name : "").replace(/[.\n\r\t]+/g, "_").trim().slice(0, 100);
    return n || "Layer";
  }
  var visible = (xs) => (xs != null ? xs : []).filter((x) => x.visible !== false);
  var paintAlpha = (p) => {
    var _a, _b, _c;
    return ((_a = p.opacity) != null ? _a : 1) * ((_c = (_b = p.color) == null ? void 0 : _b.a) != null ? _c : 1);
  };
  function note(ctx, level, what, node, detail) {
    if (ctx.report.notes.some((n) => n.what === what && n.node === node.name && n.detail === detail)) return;
    ctx.report.notes.push({ level, what, node: node.name, detail });
  }
  function boxOf(n) {
    var _a, _b, _c, _d;
    const b = n.absoluteBoundingBox;
    if (b) {
      if (n.rotation && n.size) return { x: b.x + b.width / 2 - n.size.x / 2, y: b.y + b.height / 2 - n.size.y / 2, width: n.size.x, height: n.size.y };
      return b;
    }
    return { x: 0, y: 0, width: (_b = (_a = n.size) == null ? void 0 : _a.x) != null ? _b : 100, height: (_d = (_c = n.size) == null ? void 0 : _c.y) != null ? _d : 100 };
  }
  function gradientProps(p, w, h) {
    var _a, _b;
    const stops = (_a = p.gradientStops) != null ? _a : [];
    if (stops.length < 1) return null;
    const hp = (_b = p.gradientHandlePositions) != null ? _b : [{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }];
    const [a, b] = hp;
    const dx = (b.x - a.x) * w;
    const dy = (b.y - a.y) * h;
    const angle = Math.atan2(dy, dx);
    const rotation = Math.round(angle * 180 / Math.PI);
    const rad = rotation * Math.PI / 180;
    const dir = { x: Math.cos(rad), y: Math.sin(rad) };
    const half = (Math.abs(w * dir.x) + Math.abs(h * dir.y)) / 2 || 1;
    const start = { x: w / 2 - dir.x * half, y: h / 2 - dir.y * half };
    let approx;
    const mapped = stops.map((s) => {
      var _a2, _b2;
      const P = { x: a.x * w + s.position * dx, y: a.y * h + s.position * dy };
      const t = ((P.x - start.x) * dir.x + (P.y - start.y) * dir.y) / (2 * half);
      return { t, c: s.color, alpha: ((_a2 = p.opacity) != null ? _a2 : 1) * ((_b2 = s.color.a) != null ? _b2 : 1) };
    }).sort((x, y) => x.t - y.t);
    if (mapped.some((m) => m.t < -0.01 || m.t > 1.01)) approx = "gradient handles extend past the element; stops clamped to its edges";
    const pts = mapped.map((m) => __spreadProps(__spreadValues({}, m), { t: clamp01(m.t) }));
    if (pts[0].t > 0) pts.unshift(__spreadProps(__spreadValues({}, pts[0]), { t: 0 }));
    if (pts[pts.length - 1].t < 1) pts.push(__spreadProps(__spreadValues({}, pts[pts.length - 1]), { t: 1 }));
    const out = [];
    for (const q of pts) {
      if (out.length && q.t - out[out.length - 1].t < 5e-4) {
        if (q.t >= 1) out[out.length - 1] = q;
        continue;
      }
      out.push(q);
    }
    if (out.length > 20) {
      approx = "more than 20 stops; reduced to 20";
      out.splice(19, out.length - 20);
    }
    if (out.length === 1) out.push(__spreadProps(__spreadValues({}, out[0]), { t: 1 }));
    out[0].t = 0;
    out[out.length - 1].t = 1;
    const color = { t: "ColorSequence", v: out.map((q) => [r4(q.t), r4(q.c.r), r4(q.c.g), r4(q.c.b)]) };
    const opaque = out.every((q) => q.alpha >= 0.999);
    return __spreadValues(__spreadValues({ rotation, color }, opaque ? {} : { transparency: { t: "NumberSequence", v: out.map((q) => [r4(q.t), r4(1 - q.alpha)]) } }), approx ? { approx } : {});
  }
  function gradientInst(g) {
    return { className: "UIGradient", name: "UIGradient", props: __spreadValues({ Rotation: g.rotation, Color: g.color }, g.transparency ? { Transparency: g.transparency } : {}), children: [] };
  }
  function paintsOf(ctx, node) {
    var _a, _b;
    const fills = visible(node.fills);
    const colors = fills.filter((p) => p.type === "SOLID" || p.type.startsWith("GRADIENT_"));
    const images = fills.filter((p) => p.type === "IMAGE");
    if (colors.length > 1) note(ctx, "approx", "stacked fills", node, `${colors.length} colour fills; used the top one`);
    if (images.length > 1) note(ctx, "approx", "stacked image fills", node, "used the top image fill");
    for (const p of fills) if (p.blendMode && p.blendMode !== "NORMAL" && p.blendMode !== "PASS_THROUGH") note(ctx, "dropped", "blend mode", node, `${p.blendMode.toLowerCase()} fill drawn as normal`);
    for (const p of fills) if (p.type === "VIDEO" || p.type === "PATTERN" || p.type === "EMOJI") note(ctx, "dropped", `${p.type.toLowerCase()} fill`, node, "not supported in Roblox UI");
    return { color: (_a = colors[colors.length - 1]) != null ? _a : null, image: (_b = images[images.length - 1]) != null ? _b : null };
  }
  function background(ctx, node, paint, w, h, opacity) {
    var _a;
    if (!paint) return { props: { BackgroundTransparency: 1 }, extra: [] };
    if (paint.type === "SOLID" && paint.color) return { props: { BackgroundColor3: color3(paint.color), BackgroundTransparency: r4(1 - paintAlpha(paint) * opacity) }, extra: [] };
    if (paint.type !== "GRADIENT_LINEAR") note(ctx, "approx", `${paint.type.replace("GRADIENT_", "").toLowerCase()} gradient`, node, "drawn as a linear UIGradient along the handle direction");
    const g = gradientProps(paint, w, h);
    if (!g) return { props: { BackgroundTransparency: 1 }, extra: [] };
    if (g.approx) note(ctx, "approx", "gradient", node, g.approx);
    return { props: { BackgroundColor3: color3({ r: 1, g: 1, b: 1 }), BackgroundTransparency: r4(1 - ((_a = paint.opacity) != null ? _a : 1) * opacity * (g.transparency ? 1 : 1)) }, extra: [gradientInst(g)] };
  }
  function cornerOf(ctx, node, w, h) {
    let r = 0;
    if (node.type === "ELLIPSE") return { className: "UICorner", name: "UICorner", props: { CornerRadius: udim(0.5, 0) }, children: [] };
    if (node.rectangleCornerRadii) {
      const rs = node.rectangleCornerRadii;
      r = Math.max(...rs);
      if (rs.some((x) => Math.abs(x - r) > 0.5)) note(ctx, "approx", "per-corner radius", node, `radii ${rs.join("/")}: UICorner rounds every corner, used ${r2(r)}`);
    } else if (typeof node.cornerRadius === "number") r = node.cornerRadius;
    if (r <= 0) return null;
    if (r >= Math.min(w, h) / 2 - 0.5) return { className: "UICorner", name: "UICorner", props: { CornerRadius: udim(0.5, 0) }, children: [] };
    return { className: "UICorner", name: "UICorner", props: { CornerRadius: udim(0, r) }, children: [] };
  }
  function strokeOf(ctx, node, text, w, h) {
    var _a, _b;
    const strokes = visible(node.strokes);
    if (!strokes.length) return null;
    const p = strokes[strokes.length - 1];
    let weight = (_a = node.strokeWeight) != null ? _a : 1;
    if (node.individualStrokeWeights) {
      const s = node.individualStrokeWeights;
      const max = Math.max(s.top, s.right, s.bottom, s.left);
      if ([s.top, s.right, s.bottom, s.left].some((x) => x !== max)) note(ctx, "approx", "per-side stroke", node, `UIStroke has one thickness; used ${max}`);
      weight = max;
    }
    if (weight <= 0) return null;
    if ((_b = node.strokeDashes) == null ? void 0 : _b.length) note(ctx, "dropped", "dashed stroke", node, "UIStroke is solid");
    if (!text && node.strokeAlign && node.strokeAlign !== "OUTSIDE") note(ctx, "approx", `${node.strokeAlign.toLowerCase()} stroke`, node, "UIStroke draws outside the border");
    const props = { ApplyStrokeMode: enumv("ApplyStrokeMode", text ? "Contextual" : "Border"), Thickness: r2(weight), LineJoinMode: enumv("LineJoinMode", "Round") };
    const children = [];
    if (p.type === "SOLID" && p.color) {
      props.Color = color3(p.color);
      props.Transparency = r4(1 - paintAlpha(p));
    } else if (p.type.startsWith("GRADIENT_")) {
      const g = gradientProps(p, w, h);
      props.Color = color3({ r: 1, g: 1, b: 1 });
      if (g) children.push(gradientInst(g));
    } else {
      note(ctx, "dropped", "image stroke", node, "UIStroke needs a colour");
      return null;
    }
    return { className: "UIStroke", name: "UIStroke", props, children };
  }
  function shadowLayers(ctx, node, shadow, corner, w, h) {
    var _a, _b, _c, _d, _e;
    const blur = Math.max(0, (_a = shadow.radius) != null ? _a : 0);
    const spread = (_b = shadow.spread) != null ? _b : 0;
    const c = (_c = shadow.color) != null ? _c : { r: 0, g: 0, b: 0, a: 0.25 };
    const off = (_d = shadow.offset) != null ? _d : { x: 0, y: 0 };
    const layers = blur > 1 ? 3 : 1;
    note(ctx, "approx", "drop shadow", node, blur > 1 ? `${layers} stacked rounded Frames, offset ${off.x},${off.y}, spread to ${r2(blur)}px (Roblox UI has no blur)` : `an offset rounded Frame at ${off.x},${off.y}`);
    const radius = corner && corner.props.CornerRadius && typeof corner.props.CornerRadius === "object" && "v" in corner.props.CornerRadius ? corner.props.CornerRadius.v : [0, 0];
    const out = [];
    for (let k = layers; k >= 1; k--) {
      const grow = spread + blur * k / layers / 1.5;
      const alpha = ((_e = c.a) != null ? _e : 0.25) / layers / (k === 1 ? 0.8 : 1.15);
      out.push({
        className: "Frame",
        name: layers > 1 ? `Shadow${k}` : "Shadow",
        props: {
          AnchorPoint: vec2(0.5, 0.5),
          Position: udim2(0.5, off.x, 0.5, off.y),
          Size: udim2(1, grow * 2, 1, grow * 2),
          BackgroundColor3: color3(c),
          BackgroundTransparency: r4(1 - clamp01(alpha)),
          BorderSizePixel: 0,
          ZIndex: 0
        },
        children: radius[0] || radius[1] ? [{ className: "UICorner", name: "UICorner", props: { CornerRadius: radius[0] ? udim(radius[0], 0) : udim(0, radius[1] + grow) }, children: [] }] : []
      });
    }
    void w;
    void h;
    return out;
  }
  function constraintAxis(c, pos, size, parent) {
    switch (c) {
      case "RIGHT":
      case "BOTTOM":
      case "MAX":
        return { anchor: 1, scale: 1, offset: -(parent - pos - size), sizeScale: 0, sizeOffset: size };
      case "CENTER":
        return { anchor: 0.5, scale: 0.5, offset: pos + size / 2 - parent / 2, sizeScale: 0, sizeOffset: size };
      case "LEFT_RIGHT":
      case "TOP_BOTTOM":
      case "STRETCH":
        return { anchor: 0, scale: 0, offset: pos, sizeScale: 1, sizeOffset: -(parent - size) };
      case "SCALE":
        return parent > 0 ? { anchor: 0, scale: pos / parent, offset: 0, sizeScale: size / parent, sizeOffset: 0 } : { anchor: 0, scale: 0, offset: pos, sizeScale: 0, sizeOffset: size };
      default:
        return { anchor: 0, scale: 0, offset: pos, sizeScale: 0, sizeOffset: size };
    }
  }
  function freePlacement(node, box, parent) {
    var _a, _b;
    const x = constraintAxis((_a = node.constraints) == null ? void 0 : _a.horizontal, box.x - parent.x, box.width, parent.width);
    const y = constraintAxis((_b = node.constraints) == null ? void 0 : _b.vertical, box.y - parent.y, box.height, parent.height);
    const props = { Position: udim2(x.scale, x.offset, y.scale, y.offset), Size: udim2(x.sizeScale, x.sizeOffset, y.sizeScale, y.sizeOffset) };
    if (x.anchor || y.anchor) props.AnchorPoint = vec2(x.anchor, y.anchor);
    return { props, extra: [] };
  }
  function flowPlacement(node, box, parent, order) {
    var _a, _b;
    const horizontal = parent.layoutMode === "HORIZONTAL";
    const hSizing = (_a = node.layoutSizingHorizontal) != null ? _a : horizontal ? node.layoutGrow ? "FILL" : "FIXED" : node.layoutAlign === "STRETCH" ? "FILL" : "FIXED";
    const vSizing = (_b = node.layoutSizingVertical) != null ? _b : !horizontal ? node.layoutGrow ? "FILL" : "FIXED" : node.layoutAlign === "STRETCH" ? "FILL" : "FIXED";
    const extra = [];
    let xs = 0;
    let xo = box.width;
    let ys = 0;
    let yo = box.height;
    if (hSizing === "FILL") {
      if (horizontal) extra.push({ className: "UIFlexItem", name: "UIFlexItem", props: { FlexMode: enumv("UIFlexMode", "Fill") }, children: [] });
      else xs = 1, xo = 0;
    }
    if (vSizing === "FILL") {
      if (!horizontal) extra.push({ className: "UIFlexItem", name: "UIFlexItem", props: { FlexMode: enumv("UIFlexMode", "Fill") }, children: [] });
      else ys = 1, yo = 0;
    }
    const props = { Size: udim2(xs, xo, ys, yo), LayoutOrder: order };
    const auto = hSizing === "HUG" && vSizing === "HUG" ? "XY" : hSizing === "HUG" ? "X" : vSizing === "HUG" ? "Y" : null;
    if (auto && node.type !== "TEXT") props.AutomaticSize = enumv("AutomaticSize", auto);
    return { props, extra };
  }
  function listLayout(ctx, node) {
    var _a, _b, _c, _d, _e, _f, _g;
    const horizontal = node.layoutMode === "HORIZONTAL";
    const main = (_a = node.primaryAxisAlignItems) != null ? _a : "MIN";
    const cross = (_b = node.counterAxisAlignItems) != null ? _b : "MIN";
    const al = (v, x) => v === "CENTER" || v === "BASELINE" ? "Center" : v === "MAX" ? x ? "Right" : "Bottom" : x ? "Left" : "Top";
    if (cross === "BASELINE") note(ctx, "approx", "baseline alignment", node, "centred (UIListLayout has no baseline alignment)");
    const props = {
      FillDirection: enumv("FillDirection", horizontal ? "Horizontal" : "Vertical"),
      SortOrder: enumv("SortOrder", "LayoutOrder"),
      Padding: udim(0, main === "SPACE_BETWEEN" ? 0 : (_c = node.itemSpacing) != null ? _c : 0),
      HorizontalAlignment: enumv("HorizontalAlignment", horizontal ? main === "SPACE_BETWEEN" ? "Left" : al(main, true) : al(cross, true)),
      VerticalAlignment: enumv("VerticalAlignment", horizontal ? al(cross, false) : main === "SPACE_BETWEEN" ? "Top" : al(main, false))
    };
    if (main === "SPACE_BETWEEN") props[horizontal ? "HorizontalFlex" : "VerticalFlex"] = enumv("UIFlexAlignment", "SpaceBetween");
    if (node.layoutWrap === "WRAP") {
      props.Wraps = true;
      if (node.counterAxisSpacing) note(ctx, "approx", "wrap gap", node, `row gap ${node.counterAxisSpacing}px: UIListLayout uses one Padding for both`);
    }
    if (node.itemReverseZIndex) note(ctx, "dropped", "reverse stacking", node, "children stack in layout order");
    const out = [{ className: "UIListLayout", name: "UIListLayout", props, children: [] }];
    const pad = [(_d = node.paddingTop) != null ? _d : 0, (_e = node.paddingRight) != null ? _e : 0, (_f = node.paddingBottom) != null ? _f : 0, (_g = node.paddingLeft) != null ? _g : 0];
    if (pad.some((p) => p > 0)) out.push({ className: "UIPadding", name: "UIPadding", props: { PaddingTop: udim(0, pad[0]), PaddingRight: udim(0, pad[1]), PaddingBottom: udim(0, pad[2]), PaddingLeft: udim(0, pad[3]) }, children: [] });
    return out;
  }
  function iconLike(node) {
    var _a, _b;
    if (VECTOR_TYPES.has(node.type)) return true;
    if (!((_a = node.children) == null ? void 0 : _a.length) || node.type === "TEXT") return false;
    const b = node.absoluteBoundingBox;
    if (b && (b.width > 160 || b.height > 160)) return false;
    let vectors = 0;
    const walk2 = (n) => {
      var _a2;
      if (n.visible === false) return true;
      if (n.type === "TEXT") return false;
      if (visible(n.fills).some((p) => p.type === "IMAGE")) return false;
      if (VECTOR_TYPES.has(n.type)) {
        vectors++;
        return true;
      }
      if (n.type === "ELLIPSE" || n.type === "RECTANGLE") return true;
      return ((_a2 = n.children) != null ? _a2 : []).every(walk2);
    };
    return ((_b = node.children) != null ? _b : []).every(walk2) && vectors > 0;
  }
  function imageRequest(ctx, kind, ref, node) {
    const key2 = `${kind === "fill" ? "fill" : "node"}:${ref}`;
    const existing = ctx.report.images.find((i) => i.key === key2);
    if (existing) return existing;
    let base = slug(node.name);
    for (let i = 2; ctx.imageNames.has(base); i++) base = `${slug(node.name)}-${i}`;
    ctx.imageNames.add(base);
    const req = { key: key2, kind, ref, file: `${ctx.opts.imageDir}/${base}.png`, node: node.name };
    ctx.report.images.push(req);
    return req;
  }
  var SCALE_TYPE = { FILL: "Crop", FIT: "Fit", TILE: "Tile", STRETCH: "Stretch", CROP: "Crop" };
  function textProps(ctx, node, opacity, w, h) {
    var _a, _b, _c, _d;
    const st = (_a = node.style) != null ? _a : {};
    const font = mapFont(st.fontFamily, st.fontWeight, st.italic, st.fontPostScriptName);
    if (!ctx.report.fonts.some((f) => f.figma === font.figma && f.weight === font.weight && f.style === font.style)) ctx.report.fonts.push(font);
    if (!font.exact) note(ctx, "approx", "font", node, `${font.figma} -> ${font.family} ${font.weight}${font.reason ? ` (${font.reason})` : ""}`);
    let text = (_b = node.characters) != null ? _b : "";
    switch (st.textCase) {
      case "UPPER":
        text = text.toUpperCase();
        break;
      case "LOWER":
        text = text.toLowerCase();
        break;
      case "TITLE":
        text = text.replace(/\b\w/g, (c) => c.toUpperCase());
        break;
      case "SMALL_CAPS":
      case "SMALL_CAPS_FORCED":
        text = text.toUpperCase();
        note(ctx, "approx", "small caps", node, "written in capitals");
        break;
    }
    if ((_c = node.characterStyleOverrides) == null ? void 0 : _c.some((x) => x !== 0)) note(ctx, "approx", "mixed text styles", node, "one style for the whole label (use RichText for runs)");
    if (st.letterSpacing && Math.abs(st.letterSpacing) > 0.05) note(ctx, "dropped", "letter spacing", node, `${r2(st.letterSpacing)}px tracking (TextLabel has none)`);
    if (st.textDecoration && st.textDecoration !== "NONE") note(ctx, "dropped", st.textDecoration.toLowerCase(), node, "not a TextLabel property (RichText <u>/<s> can do it)");
    const size = (_d = st.fontSize) != null ? _d : 14;
    const props = {
      Text: text,
      FontFace: { t: "Font", family: font.asset, weight: font.weight, style: font.style },
      TextSize: px(size),
      TextXAlignment: enumv("TextXAlignment", st.textAlignHorizontal === "CENTER" ? "Center" : st.textAlignHorizontal === "RIGHT" ? "Right" : "Left"),
      TextYAlignment: enumv("TextYAlignment", st.textAlignVertical === "CENTER" ? "Center" : st.textAlignVertical === "BOTTOM" ? "Bottom" : "Top"),
      TextWrapped: st.textAutoResize !== "WIDTH_AND_HEIGHT",
      BackgroundTransparency: 1
    };
    if (Math.abs(size - Math.round(size)) > 0.01) note(ctx, "approx", "text size", node, `${size}px rounded to ${px(size)}`);
    if (st.textAlignHorizontal === "JUSTIFIED") note(ctx, "approx", "justified text", node, "left aligned");
    if (st.textAutoResize === "WIDTH_AND_HEIGHT") props.AutomaticSize = enumv("AutomaticSize", "XY");
    else if (st.textAutoResize === "HEIGHT") props.AutomaticSize = enumv("AutomaticSize", "Y");
    else if (st.textAutoResize === "TRUNCATE") props.TextTruncate = enumv("TextTruncate", "AtEnd");
    if (st.lineHeightUnit && st.lineHeightUnit !== "INTRINSIC_%" && st.lineHeightPx) {
      const lh = st.lineHeightPx / (size * 1.2);
      if (Math.abs(lh - 1) > 0.04) {
        props.LineHeight = r2(Math.max(1, Math.min(3, lh)));
        if (lh < 1) note(ctx, "approx", "tight line height", node, `${r2(st.lineHeightPx)}px is below Roblox's minimum LineHeight of 1`);
      }
    }
    const extra = [];
    const fills = visible(node.fills);
    const p = fills[fills.length - 1];
    if ((p == null ? void 0 : p.type) === "SOLID" && p.color) {
      props.TextColor3 = color3(p.color);
      props.TextTransparency = r4(1 - paintAlpha(p) * opacity);
    } else if (p == null ? void 0 : p.type.startsWith("GRADIENT_")) {
      const g = gradientProps(p, w, h);
      props.TextColor3 = color3({ r: 1, g: 1, b: 1 });
      props.TextTransparency = r4(1 - opacity);
      if (g) extra.push(gradientInst(g));
    } else props.TextColor3 = color3({ r: 0, g: 0, b: 0 });
    return { props, extra };
  }
  function mapChild(ctx, node, parent, parentBox, order, inheritedButton) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k;
    if (node.visible === false) {
      note(ctx, "info", "hidden layer", node, "skipped");
      return null;
    }
    if (node.isMask) {
      note(ctx, "approx", "mask", node, "masks are not supported; the parent clips instead (ClipsDescendants)");
      return null;
    }
    const box = boxOf(node);
    const w = box.width;
    const h = box.height;
    const opacity = (_a = node.opacity) != null ? _a : 1;
    const name = instanceName(node.name);
    const flow = !!parent && (parent.layoutMode === "HORIZONTAL" || parent.layoutMode === "VERTICAL") && node.layoutPositioning !== "ABSOLUTE";
    const placement = !parent || !parentBox ? { props: { AnchorPoint: vec2(0.5, 0.5), Position: udim2(0.5, 0, 0.5, 0), Size: udim2(0, w, 0, h) }, extra: [] } : flow ? flowPlacement(node, box, parent, order) : freePlacement(node, box, parentBox);
    if (node.rotation && Math.abs(node.rotation) > 0.05) {
      placement.props.Rotation = r2(-node.rotation);
      if (!node.size) note(ctx, "approx", "rotation", node, "size taken from the rotated bounding box");
    }
    if (node.blendMode && !["NORMAL", "PASS_THROUGH"].includes(node.blendMode)) note(ctx, "dropped", "blend mode", node, `${node.blendMode.toLowerCase()} drawn as normal`);
    for (const e of visible(node.effects)) {
      if (e.type === "LAYER_BLUR" || e.type === "BACKGROUND_BLUR") note(ctx, "dropped", e.type === "LAYER_BLUR" ? "layer blur" : "background blur", node, "Roblox UI has no blur");
      else if (e.type === "INNER_SHADOW") note(ctx, "dropped", "inner shadow", node, "no inner shadows in Roblox UI");
      else if (e.type === "TEXTURE" || e.type === "NOISE") note(ctx, "dropped", e.type.toLowerCase(), node, "not supported");
    }
    const shadows = visible(node.effects).filter((e) => e.type === "DROP_SHADOW");
    if (shadows.length > 1) note(ctx, "approx", "multiple shadows", node, "used the first drop shadow");
    let button = false;
    if (!inheritedButton && ctx.opts.interactive !== "none" && node.type !== "TEXT") {
      if (ctx.opts.interactive === "root" ? !parent : BUTTON_RE.test(node.name)) button = true;
    }
    const insideButton = inheritedButton || button;
    if (button) ctx.buttonUsed = true;
    let inst;
    if (node.type === "TEXT") {
      const t = textProps(ctx, node, opacity, w, h);
      inst = { className: "TextLabel", name, props: __spreadValues({}, t.props), children: [...t.extra], figmaId: node.id };
      const st = strokeOf(ctx, node, true, w, h);
      if (st) inst.children.push(st);
    } else if (iconLike(node) && !button) {
      const req = imageRequest(ctx, "render", node.id, node);
      if (!VECTOR_TYPES.has(node.type)) note(ctx, "info", "icon", node, `vector group rendered to ${req.file}`);
      else note(ctx, "approx", "vector", node, `rendered to ${req.file} (Roblox UI draws images, not paths)`);
      inst = { className: "ImageLabel", name, props: __spreadValues({ BackgroundTransparency: 1, Image: req.file, ScaleType: enumv("ScaleType", "Fit") }, opacity < 1 ? { ImageTransparency: r4(1 - opacity) } : {}), children: [], figmaId: node.id };
    } else {
      if (!CONTAINER_TYPES.has(node.type)) note(ctx, "info", node.type.toLowerCase(), node, "mapped as a Frame");
      const paints2 = paintsOf(ctx, node);
      const kids = ((_b = node.children) != null ? _b : []).filter((c) => c.visible !== false);
      const group = opacity < 0.99 && kids.length > 0 && !button;
      const ownOpacity = group ? 1 : opacity;
      const bg = background(ctx, node, paints2.color, w, h, ownOpacity);
      const corner = cornerOf(ctx, node, w, h);
      const imageOnly = paints2.image && !kids.length && !button;
      const className = button ? imageOnly ? "ImageButton" : "TextButton" : imageOnly ? "ImageLabel" : group ? "CanvasGroup" : "Frame";
      const props = __spreadProps(__spreadValues({}, bg.props), { BorderSizePixel: 0 });
      if (className === "TextButton") Object.assign(props, { Text: "", AutoButtonColor: false });
      if (group) {
        props.GroupTransparency = r4(1 - opacity);
        note(ctx, "info", "layer opacity", node, "CanvasGroup (renders the group to a texture; costs memory)");
      } else if (opacity < 0.99 && kids.length) note(ctx, "approx", "layer opacity", node, "applied to the element only, not its children");
      if (node.clipsContent && kids.length && !group) props.ClipsDescendants = true;
      const children = [...bg.extra];
      if (corner) children.push(corner);
      const stroke = strokeOf(ctx, node, false, w, h);
      if (stroke) children.push(stroke);
      if (paints2.image) {
        const req = imageRequest(ctx, "fill", (_c = paints2.image.imageRef) != null ? _c : node.id, node);
        const scaleType = (_e = SCALE_TYPE[(_d = paints2.image.scaleMode) != null ? _d : "FILL"]) != null ? _e : "Crop";
        if (paints2.image.scaleMode === "STRETCH" || paints2.image.scaleMode === "CROP") note(ctx, "approx", "image crop", node, "custom image transform drawn as Crop");
        const imageProps = { Image: req.file, ScaleType: enumv("ScaleType", scaleType), ImageTransparency: r4(1 - ((_f = paints2.image.opacity) != null ? _f : 1) * ownOpacity) };
        if (imageOnly) Object.assign(props, imageProps);
        else children.push({ className: "ImageLabel", name: "Image", props: __spreadProps(__spreadValues({}, imageProps), { Size: udim2(1, 0, 1, 0), BackgroundTransparency: 1, BorderSizePixel: 0, ZIndex: 0 }), children: corner ? [__spreadProps(__spreadValues({}, corner), { children: [] })] : [] });
      }
      const layout = node.layoutMode === "HORIZONTAL" || node.layoutMode === "VERTICAL";
      if (node.layoutMode === "GRID") note(ctx, "approx", "grid auto layout", node, "children placed where they are (no UIGridLayout mapping)");
      const flowKids = layout ? kids.filter((c) => c.layoutPositioning !== "ABSOLUTE") : [];
      const freeKids = layout ? kids.filter((c) => c.layoutPositioning === "ABSOLUTE") : kids;
      if (layout && flowKids.length) {
        const own = node.layoutSizingHorizontal === "HUG" || node.layoutSizingVertical === "HUG" || node.primaryAxisSizingMode === "AUTO";
        if (own && !parent) {
          const hug = ((_g = node.layoutSizingHorizontal) != null ? _g : node.layoutMode === "HORIZONTAL" && node.primaryAxisSizingMode === "AUTO" ? "HUG" : "FIXED") === "HUG";
          const vhug = ((_h = node.layoutSizingVertical) != null ? _h : node.layoutMode === "VERTICAL" && node.primaryAxisSizingMode === "AUTO" ? "HUG" : "FIXED") === "HUG";
          if (hug || vhug) placement.props.AutomaticSize = enumv("AutomaticSize", hug && vhug ? "XY" : hug ? "X" : "Y");
        }
        const flow2 = flowKids.map((c, i) => mapChild(ctx, c, node, box, i + 1, insideButton)).filter((x) => !!x);
        if (freeKids.length) {
          note(ctx, "approx", "absolute child in auto layout", node, 'flow children moved into a "Flow" frame');
          children.push({ className: "Frame", name: "Flow", props: { Size: udim2(1, 0, 1, 0), BackgroundTransparency: 1, BorderSizePixel: 0 }, children: [...listLayout(ctx, node), ...flow2] });
        } else children.push(...listLayout(ctx, node), ...flow2);
      }
      for (const c of freeKids) {
        const m = mapChild(ctx, c, __spreadProps(__spreadValues({}, node), { layoutMode: "NONE" }), box, 0, insideButton);
        if (m) children.push(m);
      }
      inst = { className, name, props, children, figmaId: node.id };
      if (shadows.length) {
        const layers = shadowLayers(ctx, node, shadows[0], corner, w, h);
        const wrapper = {
          className: button ? "TextButton" : "Frame",
          name,
          props: __spreadValues(__spreadValues({ BackgroundTransparency: 1, BorderSizePixel: 0 }, button ? { Text: "", AutoButtonColor: false } : {}), placement.props),
          children: [...corner ? [__spreadProps(__spreadValues({}, corner), { children: [] })] : [], ...placement.extra, ...layers],
          figmaId: node.id
        };
        if (button) {
          inst.className = className === "TextButton" ? "Frame" : className === "ImageButton" ? "ImageLabel" : className;
          delete inst.props.Text;
          delete inst.props.AutoButtonColor;
        }
        inst.name = "Body";
        inst.props.Size = udim2(1, 0, 1, 0);
        inst.props.ZIndex = 1;
        delete inst.figmaId;
        wrapper.children.push(inst);
        ctx.report.counts[inst.className] = ((_i = ctx.report.counts[inst.className]) != null ? _i : 0) + 1;
        ctx.report.counts[wrapper.className] = ((_j = ctx.report.counts[wrapper.className]) != null ? _j : 0) + 1;
        return wrapper;
      }
    }
    Object.assign(inst.props, placement.props);
    inst.children.unshift(...placement.extra);
    ctx.report.counts[inst.className] = ((_k = ctx.report.counts[inst.className]) != null ? _k : 0) + 1;
    return inst;
  }
  function dedupe(inst) {
    var _a;
    const seen = /* @__PURE__ */ new Map();
    for (const c of inst.children) {
      const n = (_a = seen.get(c.name)) != null ? _a : 0;
      seen.set(c.name, n + 1);
      if (n && !/^UI[A-Z]/.test(c.className)) c.name = `${c.name} ${n + 1}`;
      dedupe(c);
    }
  }
  function summarize(notes) {
    const approx = [...new Set(notes.filter((n) => n.level === "approx").map((n) => n.what))];
    const dropped = [...new Set(notes.filter((n) => n.level === "dropped").map((n) => n.what))];
    const parts = [];
    if (approx.length) parts.push(`approximated: ${approx.join(", ")}`);
    if (dropped.length) parts.push(`dropped: ${dropped.join(", ")}`);
    return parts.join(" \xB7 ") || "everything mapped exactly";
  }
  function mapFigmaNode(root, opts = {}) {
    var _a, _b, _c;
    const name = (_a = opts.name) != null ? _a : root.name;
    const report = { name, size: { w: boxOf(root).width, h: boxOf(root).height }, counts: {}, notes: [], fonts: [], images: [], summary: "" };
    const ctx = { report, opts: { name, imageDir: (_b = opts.imageDir) != null ? _b : `art/ui/${slug(name)}`, interactive: (_c = opts.interactive) != null ? _c : "auto" }, imageNames: /* @__PURE__ */ new Set(), buttonUsed: false };
    let mapped = mapChild(ctx, __spreadProps(__spreadValues({}, root), { visible: true, isMask: false }), null, null, 0, false);
    if (mapped && ctx.opts.interactive === "auto" && !ctx.buttonUsed && (root.type === "COMPONENT" || root.type === "INSTANCE" || root.type === "COMPONENT_SET")) {
      report.notes = [];
      report.counts = {};
      report.fonts = [];
      report.images = [];
      ctx.imageNames.clear();
      ctx.opts.interactive = "root";
      mapped = mapChild(ctx, __spreadProps(__spreadValues({}, root), { visible: true, isMask: false }), null, null, 0, false);
      report.notes.unshift({ level: "info", what: "button", node: root.name, detail: "the component root is a TextButton" });
    }
    if (!mapped) throw new Error("nothing to import");
    mapped.name = instanceName(name);
    dedupe(mapped);
    report.summary = summarize(report.notes);
    return { root: mapped, report };
  }

  // ../src/shared/uimotion/figma/types.ts
  function handlesFromTransform(t) {
    const [[a, b, c], [d, e, f]] = t;
    const det = a * e - b * d;
    if (Math.abs(det) < 1e-9) return [{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }, { x: 0, y: 1 }];
    const ia = e / det;
    const ib = -b / det;
    const id = -d / det;
    const ie = a / det;
    const ic = -(ia * c + ib * f);
    const iff = -(id * c + ie * f);
    const map = (x, y) => ({ x: ia * x + ib * y + ic, y: id * x + ie * y + iff });
    return [map(0, 0.5), map(1, 0.5), map(0, 1)];
  }

  // send.ts
  var WEIGHTS = [
    [/thin|hairline/i, 100],
    [/extra ?light|ultra ?light/i, 200],
    [/light/i, 300],
    [/medium/i, 500],
    [/semi ?bold|demi ?bold/i, 600],
    [/extra ?bold|ultra ?bold/i, 800],
    [/black|heavy/i, 900],
    [/bold/i, 700]
  ];
  var weightOf = (style) => {
    var _a, _b;
    return (_b = (_a = WEIGHTS.find(([re]) => re.test(style))) == null ? void 0 : _a[1]) != null ? _b : 400;
  };
  var num = (v) => typeof v === "number" && Number.isFinite(v) ? v : void 0;
  var isMixed = (v) => typeof v === "symbol";
  function paints(list) {
    var _a, _b;
    if (!Array.isArray(list)) return void 0;
    const out = [];
    for (const p of list) {
      const base = { visible: p.visible !== false, opacity: (_a = num(p.opacity)) != null ? _a : 1, blendMode: p.blendMode };
      if (p.type === "SOLID") out.push(__spreadProps(__spreadValues({}, base), { type: "SOLID", color: { r: p.color.r, g: p.color.g, b: p.color.b, a: 1 } }));
      else if (typeof p.type === "string" && p.type.startsWith("GRADIENT_"))
        out.push(__spreadProps(__spreadValues({}, base), { type: p.type, gradientHandlePositions: handlesFromTransform(p.gradientTransform), gradientStops: ((_b = p.gradientStops) != null ? _b : []).map((s) => ({ position: s.position, color: { r: s.color.r, g: s.color.g, b: s.color.b, a: s.color.a } })) }));
      else if (p.type === "IMAGE" && p.imageHash) out.push(__spreadProps(__spreadValues({}, base), { type: "IMAGE", imageRef: p.imageHash, scaleMode: p.scaleMode }));
      else out.push(__spreadProps(__spreadValues({}, base), { type: p.type }));
    }
    return out;
  }
  function effects(list) {
    if (!Array.isArray(list)) return void 0;
    return list.map((e) => {
      var _a;
      return __spreadValues(__spreadValues(__spreadValues({
        type: e.type,
        visible: e.visible !== false,
        radius: (_a = num(e.radius)) != null ? _a : 0
      }, e.color ? { color: { r: e.color.r, g: e.color.g, b: e.color.b, a: e.color.a } } : {}), e.offset ? { offset: { x: e.offset.x, y: e.offset.y } } : {}), num(e.spread) != null ? { spread: e.spread } : {});
    });
  }
  function textStyle(n) {
    var _a;
    const font = isMixed(n.fontName) ? n.getRangeFontName(0, 1) : n.fontName;
    const size = isMixed(n.fontSize) ? n.getRangeFontSize(0, 1) : n.fontSize;
    const ls = isMixed(n.letterSpacing) ? n.getRangeLetterSpacing(0, 1) : n.letterSpacing;
    const lh = isMixed(n.lineHeight) ? n.getRangeLineHeight(0, 1) : n.lineHeight;
    const textCase = isMixed(n.textCase) ? n.getRangeTextCase(0, 1) : n.textCase;
    const deco = isMixed(n.textDecoration) ? n.getRangeTextDecoration(0, 1) : n.textDecoration;
    const weight = isMixed(n.fontWeight) ? n.getRangeFontWeight(0, 1) : n.fontWeight;
    const style = {
      fontFamily: font.family,
      fontPostScriptName: `${font.family}-${font.style}`.replace(/\s+/g, ""),
      fontWeight: (_a = num(weight)) != null ? _a : weightOf(font.style),
      italic: /italic|oblique/i.test(font.style),
      fontSize: size,
      textAlignHorizontal: n.textAlignHorizontal,
      textAlignVertical: n.textAlignVertical,
      letterSpacing: ls.unit === "PERCENT" ? ls.value / 100 * size : ls.value,
      textCase: textCase === "ORIGINAL" ? "ORIGINAL" : textCase,
      textDecoration: deco,
      textAutoResize: n.textAutoResize
    };
    if (lh.unit === "PIXELS") Object.assign(style, { lineHeightPx: lh.value, lineHeightUnit: "PIXELS" });
    else if (lh.unit === "PERCENT") Object.assign(style, { lineHeightPercentFontSize: lh.value, lineHeightUnit: "FONT_SIZE_%" });
    else Object.assign(style, { lineHeightUnit: "INTRINSIC_%" });
    return style;
  }
  var H = { MIN: "LEFT", MAX: "RIGHT", CENTER: "CENTER", STRETCH: "LEFT_RIGHT", SCALE: "SCALE" };
  var V = { MIN: "TOP", MAX: "BOTTOM", CENTER: "CENTER", STRETCH: "TOP_BOTTOM", SCALE: "SCALE" };
  function serialize(n) {
    var _a, _b, _c;
    const out = { id: n.id, name: n.name, type: n.type, visible: n.visible !== false };
    const box = (_a = n.absoluteBoundingBox) != null ? _a : n.absoluteTransform ? { x: n.absoluteTransform[0][2], y: n.absoluteTransform[1][2], width: n.width, height: n.height } : null;
    if (box) out.absoluteBoundingBox = { x: box.x, y: box.y, width: box.width, height: box.height };
    if (num(n.width) != null) out.size = { x: n.width, y: n.height };
    if (num(n.rotation)) out.rotation = n.rotation;
    if (num(n.opacity) != null && n.opacity < 1) out.opacity = n.opacity;
    if (n.blendMode && n.blendMode !== "PASS_THROUGH" && n.blendMode !== "NORMAL") out.blendMode = n.blendMode;
    if (n.isMask) out.isMask = true;
    if (typeof n.clipsContent === "boolean") out.clipsContent = n.clipsContent;
    if ("fills" in n && !isMixed(n.fills)) out.fills = paints(n.fills);
    else if ("fills" in n && n.type === "TEXT") out.fills = paints(n.getRangeFills(0, 1));
    if ("strokes" in n) {
      out.strokes = paints(n.strokes);
      if (num(n.strokeWeight) != null) out.strokeWeight = n.strokeWeight;
      else if (num(n.strokeTopWeight) != null) out.individualStrokeWeights = { top: n.strokeTopWeight, right: n.strokeRightWeight, bottom: n.strokeBottomWeight, left: n.strokeLeftWeight };
      out.strokeAlign = n.strokeAlign;
      if (Array.isArray(n.dashPattern) && n.dashPattern.length) out.strokeDashes = [...n.dashPattern];
    }
    if ("cornerRadius" in n) {
      if (isMixed(n.cornerRadius)) out.rectangleCornerRadii = [n.topLeftRadius, n.topRightRadius, n.bottomRightRadius, n.bottomLeftRadius];
      else if (n.cornerRadius) out.cornerRadius = n.cornerRadius;
    }
    if ("effects" in n) out.effects = effects(n.effects);
    if (n.constraints) out.constraints = { horizontal: (_b = H[n.constraints.horizontal]) != null ? _b : n.constraints.horizontal, vertical: (_c = V[n.constraints.vertical]) != null ? _c : n.constraints.vertical };
    if (n.layoutMode && n.layoutMode !== "NONE") {
      for (const k of ["layoutMode", "layoutWrap", "itemSpacing", "counterAxisSpacing", "paddingLeft", "paddingRight", "paddingTop", "paddingBottom", "primaryAxisAlignItems", "counterAxisAlignItems", "primaryAxisSizingMode", "counterAxisSizingMode", "itemReverseZIndex"]) if (n[k] !== void 0 && n[k] !== null && !isMixed(n[k])) out[k] = n[k];
    }
    for (const k of ["layoutPositioning", "layoutSizingHorizontal", "layoutSizingVertical", "layoutGrow", "layoutAlign"]) if (n[k] !== void 0 && n[k] !== null && !isMixed(n[k])) out[k] = n[k];
    if (n.type === "TEXT") {
      out.characters = n.characters;
      out.style = textStyle(n);
    }
    if ("children" in n && Array.isArray(n.children) && !["INSTANCE_SWAP"].includes(n.type)) out.children = n.children.map(serialize);
    return out;
  }
  function walk(n, fn) {
    var _a;
    fn(n);
    for (const c of (_a = n.children) != null ? _a : []) walk(c, fn);
  }
  async function sendSelection(api) {
    var _a, _b, _c;
    const sel = api.currentPage.selection[0];
    if (!sel) throw new Error("Select a frame, component or layer to send to Forge.");
    const root = serialize(sel);
    const { report } = mapFigmaNode(root, { name: sel.name });
    const images = {};
    const missing = [];
    const hashes = /* @__PURE__ */ new Set();
    walk(root, (n) => {
      var _a2;
      return ((_a2 = n.fills) != null ? _a2 : []).forEach((p) => p.type === "IMAGE" && p.imageRef && hashes.add(p.imageRef));
    });
    for (const h of hashes) {
      try {
        const bytes = await ((_a = api.getImageByHash(h)) == null ? void 0 : _a.getBytesAsync());
        if (bytes) images[`fill:${h}`] = api.base64Encode(bytes);
        else missing.push(`image ${h}`);
      } catch (e) {
        missing.push(`image ${h}`);
      }
    }
    for (const req of report.images.filter((r) => r.kind === "render")) {
      try {
        const node = await api.getNodeByIdAsync(req.ref);
        if (!node || !("exportAsync" in node)) throw new Error("gone");
        const png = await node.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: 2 } });
        images[req.key] = api.base64Encode(png);
      } catch (e) {
        missing.push(req.node);
      }
    }
    const doc = {
      format: "forge-figma",
      version: 1,
      source: { kind: "plugin", fileName: (_b = api.root) == null ? void 0 : _b.name, page: (_c = api.currentPage) == null ? void 0 : _c.name, nodeId: sel.id, nodeName: sel.name },
      exportedAt: (/* @__PURE__ */ new Date()).toISOString(),
      root,
      images,
      summary: report.summary
    };
    const json = JSON.stringify(doc);
    return { json, name: sel.name, summary: report.summary || "maps exactly", images: Object.keys(images).length, missing, bytes: json.length };
  }

  // code.ts
  var KEY = "forge";
  var DOC_KEY = "forge-doc";
  var TEXT_LAYER = "#text";
  var IMAGE_LAYER = "#image";
  figma.showUI(__html__, { width: 380, height: 520, themeColors: true });
  function rgb(hex2) {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex2);
    if (!m) return { r: 0.5, g: 0.5, b: 0.5 };
    return { r: parseInt(m[1], 16) / 255, g: parseInt(m[2], 16) / 255, b: parseInt(m[3], 16) / 255 };
  }
  function hex(c) {
    const h = (x) => Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, "0");
    return `#${h(c.r)}${h(c.g)}${h(c.b)}`.toUpperCase();
  }
  var round = (n) => Math.round(n * 100) / 100;
  function placeRotated(node, x, y, w, h, degrees) {
    if (!degrees) {
      node.x = x;
      node.y = y;
      return;
    }
    const t = degrees * Math.PI / 180;
    const a = Math.cos(t);
    const b = -Math.sin(t);
    const c = Math.sin(t);
    const d = Math.cos(t);
    const cx = x + w / 2;
    const cy = y + h / 2;
    node.relativeTransform = [
      [a, b, cx - a * w / 2 - b * h / 2],
      [c, d, cy - c * w / 2 - d * h / 2]
    ];
  }
  function gradientPaint(g) {
    const t = -g.rotation * Math.PI / 180;
    const cos = Math.cos(t);
    const sin = Math.sin(t);
    return {
      type: "GRADIENT_LINEAR",
      gradientTransform: [
        [cos, -sin, 0.5 - cos * 0.5 + sin * 0.5],
        [sin, cos, 0.5 - sin * 0.5 - cos * 0.5]
      ],
      gradientStops: g.stops.map((s) => ({ position: Math.max(0, Math.min(1, s.t)), color: __spreadProps(__spreadValues({}, rgb(s.color)), { a: s.opacity }) }))
    };
  }
  function readGradient(p) {
    const [[a], [c]] = p.gradientTransform;
    const rotation = Math.round(-Math.atan2(c, a) * 180 / Math.PI);
    return { rotation, stops: p.gradientStops.map((s) => {
      var _a;
      return { t: round(s.position), color: hex(s.color), opacity: round(s.color.a * ((_a = p.opacity) != null ? _a : 1)) };
    }) };
  }
  var STYLE_BY_WEIGHT = { 100: "Thin", 200: "ExtraLight", 300: "Light", 400: "Regular", 500: "Medium", 600: "SemiBold", 700: "Bold", 800: "ExtraBold", 900: "Black" };
  var WEIGHT_BY_STYLE = { thin: 100, extralight: 200, "extra light": 200, light: 300, regular: 400, medium: 500, semibold: 600, "semi bold": 600, bold: 700, extrabold: 800, "extra bold": 800, black: 900, heavy: 900 };
  var loaded = /* @__PURE__ */ new Map();
  async function loadFont(text) {
    var _a;
    const style = (_a = STYLE_BY_WEIGHT[text.weight]) != null ? _a : "Regular";
    const styled = text.italic ? style === "Regular" ? "Italic" : `${style} Italic` : style;
    const tries = [
      { family: text.substitute, style: styled },
      { family: text.substitute, style: text.italic ? "Italic" : "Regular" },
      { family: text.substitute, style },
      { family: "Inter", style: text.weight >= 600 ? "Bold" : "Regular" },
      { family: "Inter", style: "Regular" }
    ];
    for (const f of tries) {
      const key2 = `${f.family}|${f.style}`;
      if (!loaded.has(key2)) {
        try {
          await figma.loadFontAsync(f);
          loaded.set(key2, f);
        } catch (e) {
          loaded.set(key2, null);
        }
      }
      const hit = loaded.get(key2);
      if (hit) return hit;
    }
    return { family: "Inter", style: "Regular" };
  }
  var H_ALIGN = { Left: "MIN", Center: "CENTER", Right: "MAX", Top: "MIN", Bottom: "MAX" };
  async function build(n, parent, origin, inAutoLayout) {
    var _a, _b;
    const f = figma.createFrame();
    parent.appendChild(f);
    f.name = n.name;
    f.resize(Math.max(0.01, n.w), Math.max(0.01, n.h));
    if (inAutoLayout) f.layoutSizingHorizontal = "FIXED";
    if (inAutoLayout) f.layoutSizingVertical = "FIXED";
    else placeRotated(f, n.x - origin.x, n.y - origin.y, n.w, n.h, n.rotation);
    f.visible = n.visible;
    f.clipsContent = n.clips;
    const fills = [];
    if (n.fill && n.gradient) fills.push(gradientPaint(n.gradient));
    else if (n.fill) fills.push({ type: "SOLID", color: rgb(n.fill.color), opacity: n.fill.opacity });
    f.fills = fills;
    if (n.corner) f.cornerRadius = n.corner;
    if (n.stroke && n.stroke.target === "border") {
      f.strokes = [{ type: "SOLID", color: rgb(n.stroke.color), opacity: n.stroke.opacity }];
      f.strokeWeight = n.stroke.thickness;
      f.strokeAlign = "OUTSIDE";
    }
    if (n.padding) {
      f.paddingTop = n.padding.top;
      f.paddingRight = n.padding.right;
      f.paddingBottom = n.padding.bottom;
      f.paddingLeft = n.padding.left;
    }
    f.setPluginData(KEY, JSON.stringify({ id: n.id, path: n.path, cls: n.cls, name: n.name, props: n.props, text: n.text, image: n.image, layout: n.layout, fill: n.fill }));
    if (n.image) {
      const img = figma.createRectangle();
      f.appendChild(img);
      img.name = IMAGE_LAYER;
      img.resize(Math.max(0.01, n.w), Math.max(0.01, n.h));
      const data = n.image.url && /^data:image\/(png|jpe?g|gif);base64,/.exec(n.image.url);
      if (data) {
        const image = figma.createImage(figma.base64Decode(n.image.url.slice(n.image.url.indexOf(",") + 1)));
        img.fills = [{ type: "IMAGE", imageHash: image.hash, scaleMode: n.image.scaleType === "Fit" ? "FIT" : n.image.scaleType === "Crop" ? "CROP" : n.image.scaleType === "Tile" ? "TILE" : "FILL", opacity: n.image.opacity }];
      } else {
        img.fills = [{ type: "SOLID", color: { r: 0.5, g: 0.5, b: 0.5 }, opacity: 0.3 }];
        img.dashPattern = [4, 3];
        img.strokes = [{ type: "SOLID", color: { r: 0.6, g: 0.6, b: 0.6 } }];
      }
      if (n.corner) img.cornerRadius = n.corner;
      if (n.layout) img.layoutPositioning = "ABSOLUTE";
    }
    if (n.text && n.text.content) {
      const t = figma.createText();
      f.appendChild(t);
      t.name = TEXT_LAYER;
      t.fontName = await loadFont(n.text);
      t.characters = n.text.rich ? n.text.content.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "") : n.text.content;
      t.fontSize = Math.max(1, n.text.size);
      t.lineHeight = { value: n.text.lineHeight * 100, unit: "PERCENT" };
      t.fills = !n.fill && n.gradient ? [gradientPaint(n.gradient)] : [{ type: "SOLID", color: rgb(n.text.color), opacity: n.text.opacity }];
      t.textAlignHorizontal = n.text.alignX === "Left" ? "LEFT" : n.text.alignX === "Right" ? "RIGHT" : "CENTER";
      t.textAlignVertical = n.text.alignY === "Top" ? "TOP" : n.text.alignY === "Bottom" ? "BOTTOM" : "CENTER";
      t.textAutoResize = "NONE";
      const p = (_a = n.padding) != null ? _a : { top: 0, right: 0, bottom: 0, left: 0 };
      t.resize(Math.max(1, n.w - p.left - p.right), Math.max(1, n.h - p.top - p.bottom));
      if (n.layout) t.layoutPositioning = "ABSOLUTE";
      t.x = p.left;
      t.y = p.top;
      if (n.stroke && n.stroke.target === "text") {
        t.strokes = [{ type: "SOLID", color: rgb(n.stroke.color), opacity: n.stroke.opacity }];
        t.strokeWeight = n.stroke.thickness;
        t.strokeAlign = "OUTSIDE";
      }
    }
    let kids = n.children;
    if (n.layout) {
      const vertical = n.layout.direction === "Vertical";
      kids = [...kids].sort((a, b) => vertical ? a.y - b.y || a.x - b.x : a.x - b.x || a.y - b.y);
      f.layoutMode = vertical ? "VERTICAL" : "HORIZONTAL";
      f.itemSpacing = n.layout.gap;
      if (n.layout.kind === "grid" || n.layout.wraps) {
        f.layoutWrap = "WRAP";
        f.counterAxisSpacing = (_b = n.layout.gapCross) != null ? _b : n.layout.gap;
      }
      f.primaryAxisSizingMode = "FIXED";
      f.counterAxisSizingMode = "FIXED";
      f.primaryAxisAlignItems = H_ALIGN[vertical ? n.layout.alignY : n.layout.alignX];
      f.counterAxisAlignItems = H_ALIGN[vertical ? n.layout.alignX : n.layout.alignY];
      f.resize(Math.max(0.01, n.w), Math.max(0.01, n.h));
    }
    for (const c of kids) await build(c, f, { x: n.x, y: n.y }, !!n.layout);
    return f;
  }
  async function importDoc(doc) {
    if (doc.format !== "forge-ui" || !doc.root) throw new Error('Not a Forge UI document (format "forge-ui").');
    if (doc.version > 1) throw new Error(`Forge UI document version ${doc.version} is newer than this plugin.`);
    const root = figma.createFrame();
    figma.currentPage.appendChild(root);
    root.name = `Forge: ${doc.root.name}${doc.device ? ` (${doc.device})` : ""}`;
    root.resize(doc.viewport.w, doc.viewport.h);
    root.clipsContent = true;
    root.fills = [{ type: "SOLID", color: { r: 0.27, g: 0.31, b: 0.37 } }];
    const center = figma.viewport.center;
    root.x = Math.round(center.x - doc.viewport.w / 2);
    root.y = Math.round(center.y - doc.viewport.h / 2);
    root.setPluginData(DOC_KEY, JSON.stringify({ story: doc.story, device: doc.device, viewport: doc.viewport, name: doc.root.name, id: doc.root.id }));
    let count = 0;
    for (const c of doc.root.children) {
      await build(c, root, { x: 0, y: 0 }, false);
      count++;
    }
    figma.currentPage.selection = [root];
    figma.viewport.scrollAndZoomIntoView([root]);
    return { count, name: root.name };
  }
  function decompose(node, origin) {
    const [[a, b, tx], [c, d, ty]] = node.relativeTransform;
    const w = "width" in node ? node.width : 0;
    const h = "height" in node ? node.height : 0;
    const cx = tx + a * w / 2 + b * h / 2;
    const cy = ty + c * w / 2 + d * h / 2;
    const rotation = round(Math.atan2(c, a) * 180 / Math.PI);
    void d;
    return { x: round(origin.x + cx - w / 2), y: round(origin.y + cy - h / 2), w: round(w), h: round(h), rotation };
  }
  function solid(paints2) {
    var _a;
    if (!Array.isArray(paints2)) return null;
    const p = paints2.find((x) => x.type === "SOLID" && x.visible !== false);
    return p ? { color: hex(p.color), opacity: round((_a = p.opacity) != null ? _a : 1) } : null;
  }
  function gradient(paints2) {
    if (!Array.isArray(paints2)) return null;
    const p = paints2.find((x) => x.type === "GRADIENT_LINEAR" && x.visible !== false);
    return p ? readGradient(p) : null;
  }
  function exportText(t, saved) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _i;
    const font = t.fontName === figma.mixed ? { family: (_a = saved == null ? void 0 : saved.substitute) != null ? _a : "Inter", style: "Regular" } : t.fontName;
    const styleKey = font.style.toLowerCase().replace(/\s*italic\s*/, "").trim() || "regular";
    const fill = solid(t.fills);
    const lh = t.lineHeight !== figma.mixed && t.lineHeight.unit === "PERCENT" ? t.lineHeight.value / 100 : (_b = saved == null ? void 0 : saved.lineHeight) != null ? _b : 1;
    return {
      content: t.characters,
      rich: false,
      // A changed family is reported as typed in Figma; Forge maps it to a Roblox Font.
      family: saved && font.family === saved.substitute ? saved.family : font.family,
      substitute: font.family,
      weight: (_c = WEIGHT_BY_STYLE[styleKey]) != null ? _c : 400,
      italic: /italic/i.test(font.style),
      size: t.fontSize === figma.mixed ? (_d = saved == null ? void 0 : saved.size) != null ? _d : 14 : round(t.fontSize),
      lineHeight: lh,
      color: (_f = (_e = fill == null ? void 0 : fill.color) != null ? _e : saved == null ? void 0 : saved.color) != null ? _f : "#000000",
      opacity: (_g = fill == null ? void 0 : fill.opacity) != null ? _g : 1,
      alignX: t.textAlignHorizontal === "LEFT" ? "Left" : t.textAlignHorizontal === "RIGHT" ? "Right" : "Center",
      alignY: t.textAlignVertical === "TOP" ? "Top" : t.textAlignVertical === "BOTTOM" ? "Bottom" : "Center",
      wrapped: (_h = saved == null ? void 0 : saved.wrapped) != null ? _h : false,
      scaled: (_i = saved == null ? void 0 : saved.scaled) != null ? _i : false
    };
  }
  function exportNode(node, origin, parentPath) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k, _l, _m;
    if (node.name === TEXT_LAYER || node.name === IMAGE_LAYER) return null;
    const g = decompose(node, origin);
    const raw = node.getPluginData(KEY);
    const saved = raw ? JSON.parse(raw) : null;
    const isFrame = node.type === "FRAME" || node.type === "COMPONENT" || node.type === "INSTANCE" || node.type === "GROUP";
    const name = node.name;
    const path = saved && saved.name === name ? saved.path : parentPath ? `${parentPath}.${name}` : name;
    const fills = "fills" in node ? node.fills : [];
    const fill = (_b = solid(fills)) != null ? _b : gradient(fills) ? (_a = saved == null ? void 0 : saved.fill) != null ? _a : { color: "#FFFFFF", opacity: 1 } : null;
    let text = null;
    let stroke = null;
    const children = [];
    if (node.type === "TEXT") {
      text = exportText(node, null);
    } else if (isFrame && "children" in node) {
      const t = node.children.find((c) => c.name === TEXT_LAYER && c.type === "TEXT");
      if (t) {
        text = exportText(t, (_c = saved == null ? void 0 : saved.text) != null ? _c : null);
        if (Array.isArray(t.strokes) && t.strokes.length && typeof t.strokeWeight === "number") {
          const s = solid(t.strokes);
          if (s) stroke = __spreadProps(__spreadValues({}, s), { thickness: round(t.strokeWeight), target: "text" });
        }
      }
      for (const c of node.children) {
        const fc = exportNode(c, g.rotation ? { x: g.x, y: g.y } : { x: g.x, y: g.y }, path);
        if (fc) children.push(fc);
      }
    }
    if (!stroke && "strokes" in node && Array.isArray(node.strokes) && node.strokes.length && node.type !== "TEXT") {
      const s = solid(node.strokes);
      const weight = node.strokeWeight;
      if (s && typeof weight === "number") stroke = __spreadProps(__spreadValues({}, s), { thickness: round(weight), target: "border" });
    }
    let layout = null;
    if (node.type === "FRAME" && node.layoutMode !== "NONE" && node.layoutMode !== "GRID") {
      const vertical = node.layoutMode === "VERTICAL";
      const fromAlign = (v, axisX) => v === "CENTER" ? "Center" : v === "MAX" ? axisX ? "Right" : "Bottom" : axisX ? "Left" : "Top";
      layout = __spreadValues(__spreadProps(__spreadValues({
        kind: (_e = (_d = saved == null ? void 0 : saved.layout) == null ? void 0 : _d.kind) != null ? _e : "list",
        direction: vertical ? "Vertical" : "Horizontal",
        gap: round(node.itemSpacing)
      }, node.layoutWrap === "WRAP" && node.counterAxisSpacing != null ? { gapCross: round(node.counterAxisSpacing) } : {}), {
        alignX: fromAlign(vertical ? node.counterAxisAlignItems : node.primaryAxisAlignItems, true),
        alignY: fromAlign(vertical ? node.primaryAxisAlignItems : node.counterAxisAlignItems, false),
        wraps: node.layoutWrap === "WRAP"
      }), ((_f = saved == null ? void 0 : saved.layout) == null ? void 0 : _f.cell) ? { cell: saved.layout.cell } : {});
      if ((saved == null ? void 0 : saved.layout) && saved.layout.kind === "grid") layout = __spreadValues(__spreadProps(__spreadValues({}, saved.layout), { gap: layout.gap }), layout.gapCross != null ? { gapCross: layout.gapCross } : {});
    }
    const padding = node.type === "FRAME" && (node.paddingTop || node.paddingRight || node.paddingBottom || node.paddingLeft) ? { top: round(node.paddingTop), right: round(node.paddingRight), bottom: round(node.paddingBottom), left: round(node.paddingLeft) } : null;
    const corner = "cornerRadius" in node && typeof node.cornerRadius === "number" ? round(node.cornerRadius) : 0;
    return {
      id: (_g = saved == null ? void 0 : saved.id) != null ? _g : 0,
      path,
      name,
      cls: (_h = saved == null ? void 0 : saved.cls) != null ? _h : node.type === "TEXT" ? "TextLabel" : "Frame",
      x: g.x,
      y: g.y,
      w: g.w,
      h: g.h,
      rotation: g.rotation,
      visible: node.visible,
      clips: node.type === "FRAME" ? node.clipsContent : false,
      fill: node.type === "TEXT" ? null : fill,
      gradient: node.type === "TEXT" ? null : (_k = gradient(fills)) != null ? _k : text && !fill && "children" in node ? gradient((_j = (_i = node.children.find((c) => c.name === TEXT_LAYER)) == null ? void 0 : _i.fills) != null ? _j : []) : null,
      corner,
      stroke,
      padding,
      layout,
      text,
      image: (_l = saved == null ? void 0 : saved.image) != null ? _l : null,
      props: (_m = saved == null ? void 0 : saved.props) != null ? _m : {},
      children
    };
  }
  function exportSelection() {
    const sel = figma.currentPage.selection[0];
    let root = sel != null ? sel : null;
    while (root && !root.getPluginData(DOC_KEY) && root.parent && root.parent.type !== "PAGE") root = root.parent;
    if (!root || !root.getPluginData(DOC_KEY)) throw new Error("Select a frame imported by Forge UI (or anything inside it).");
    const meta = JSON.parse(root.getPluginData(DOC_KEY));
    const children = [];
    if ("children" in root) for (const c of root.children) {
      const fc = exportNode(c, { x: 0, y: 0 }, "");
      if (fc) children.push(fc);
    }
    return __spreadProps(__spreadValues({
      format: "forge-ui",
      version: 1,
      story: meta.story
    }, meta.device ? { device: meta.device } : {}), {
      viewport: meta.viewport,
      exportedAt: (/* @__PURE__ */ new Date()).toISOString(),
      root: { id: meta.id, path: "", name: meta.name, cls: "Frame", x: 0, y: 0, w: meta.viewport.w, h: meta.viewport.h, rotation: 0, visible: true, clips: true, fill: null, gradient: null, corner: 0, stroke: null, padding: null, layout: null, text: null, image: null, props: {}, children }
    });
  }
  figma.ui.onmessage = async (msg) => {
    var _a;
    try {
      if (msg.type === "import") {
        const doc = JSON.parse((_a = msg.json) != null ? _a : "");
        const result = await importDoc(doc);
        figma.ui.postMessage(__spreadValues({ type: "imported" }, result));
        figma.notify(`Imported ${result.name}`);
      } else if (msg.type === "export") {
        const doc = exportSelection();
        figma.ui.postMessage({ type: "exported", json: JSON.stringify(doc, null, 2), story: doc.story });
      } else if (msg.type === "send") {
        const sent = await sendSelection(figma);
        figma.ui.postMessage(__spreadValues({ type: "sent" }, sent));
        figma.notify(`Ready to send ${sent.name} to Forge`);
      } else if (msg.type === "close") {
        figma.closePlugin();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      figma.ui.postMessage({ type: "error", message });
      figma.notify(message, { error: true });
    }
  };
})();
