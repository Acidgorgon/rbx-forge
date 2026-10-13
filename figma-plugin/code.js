"use strict";
// Forge UI: Figma plugin for RBX Forge's UI Preview.
//
// Import: turns a Forge JSON frame (UI Preview > Figma > Forge JSON) into Figma frames. A
// UIListLayout becomes auto layout (UIGridLayout becomes wrapping auto layout); UIPadding, UICorner,
// UIStroke, UIGradient, text (font, size, colour, alignment, stroke) and rotation map across, and every
// node stores its Roblox instance path with setPluginData so it can find its way back.
// Export: turns the selected Forge frame (after edits) back into Forge JSON, which Forge's
// "Import from Figma" diffs against the live tree.
//
// Types below mirror src/shared/uiPreview/figma.ts (ForgeUiDoc v1). This file is a plain script
// (no imports), compiled with `npm run build` to code.js.
const KEY = 'forge';
const DOC_KEY = 'forge-doc';
const TEXT_LAYER = '#text';
const IMAGE_LAYER = '#image';
figma.showUI(__html__, { width: 380, height: 460, themeColors: true });
// ---- helpers
function rgb(hex) {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
    if (!m)
        return { r: 0.5, g: 0.5, b: 0.5 };
    return { r: parseInt(m[1], 16) / 255, g: parseInt(m[2], 16) / 255, b: parseInt(m[3], 16) / 255 };
}
function hex(c) {
    const h = (x) => Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, '0');
    return `#${h(c.r)}${h(c.g)}${h(c.b)}`.toUpperCase();
}
const round = (n) => Math.round(n * 100) / 100;
// Roblox rotation is clockwise around the centre; Figma positions by the top-left of a transform.
function placeRotated(node, x, y, w, h, degrees) {
    if (!degrees) {
        node.x = x;
        node.y = y;
        return;
    }
    const t = (degrees * Math.PI) / 180;
    const a = Math.cos(t);
    const b = -Math.sin(t);
    const c = Math.sin(t);
    const d = Math.cos(t);
    const cx = x + w / 2;
    const cy = y + h / 2;
    node.relativeTransform = [
        [a, b, cx - (a * w) / 2 - (b * h) / 2],
        [c, d, cy - (c * w) / 2 - (d * h) / 2]
    ];
}
// Gradient along Roblox Rotation degrees (0 = left to right). gradientTransform maps the node's
// unit square to gradient space, where the gradient runs from (0, 0.5) to (1, 0.5).
function gradientPaint(g) {
    const t = (-g.rotation * Math.PI) / 180;
    const cos = Math.cos(t);
    const sin = Math.sin(t);
    return {
        type: 'GRADIENT_LINEAR',
        gradientTransform: [
            [cos, -sin, 0.5 - cos * 0.5 + sin * 0.5],
            [sin, cos, 0.5 - sin * 0.5 - cos * 0.5]
        ],
        gradientStops: g.stops.map((s) => ({ position: Math.max(0, Math.min(1, s.t)), color: Object.assign(Object.assign({}, rgb(s.color)), { a: s.opacity }) }))
    };
}
function readGradient(p) {
    const [[a], [c]] = p.gradientTransform;
    const rotation = Math.round((-Math.atan2(c, a) * 180) / Math.PI);
    return { rotation, stops: p.gradientStops.map((s) => { var _a; return ({ t: round(s.position), color: hex(s.color), opacity: round(s.color.a * ((_a = p.opacity) !== null && _a !== void 0 ? _a : 1)) }); }) };
}
const STYLE_BY_WEIGHT = { 100: 'Thin', 200: 'ExtraLight', 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'SemiBold', 700: 'Bold', 800: 'ExtraBold', 900: 'Black' };
const WEIGHT_BY_STYLE = { thin: 100, extralight: 200, 'extra light': 200, light: 300, regular: 400, medium: 500, semibold: 600, 'semi bold': 600, bold: 700, extrabold: 800, 'extra bold': 800, black: 900, heavy: 900 };
const loaded = new Map();
async function loadFont(text) {
    var _a;
    const style = (_a = STYLE_BY_WEIGHT[text.weight]) !== null && _a !== void 0 ? _a : 'Regular';
    const styled = text.italic ? (style === 'Regular' ? 'Italic' : `${style} Italic`) : style;
    const tries = [
        { family: text.substitute, style: styled },
        { family: text.substitute, style: text.italic ? 'Italic' : 'Regular' },
        { family: text.substitute, style },
        { family: 'Inter', style: text.weight >= 600 ? 'Bold' : 'Regular' },
        { family: 'Inter', style: 'Regular' }
    ];
    for (const f of tries) {
        const key = `${f.family}|${f.style}`;
        if (!loaded.has(key)) {
            try {
                await figma.loadFontAsync(f);
                loaded.set(key, f);
            }
            catch (_b) {
                loaded.set(key, null);
            }
        }
        const hit = loaded.get(key);
        if (hit)
            return hit;
    }
    return { family: 'Inter', style: 'Regular' };
}
const H_ALIGN = { Left: 'MIN', Center: 'CENTER', Right: 'MAX', Top: 'MIN', Bottom: 'MAX' };
// ---- import
async function build(n, parent, origin, inAutoLayout) {
    var _a, _b;
    const f = figma.createFrame();
    parent.appendChild(f);
    f.name = n.name;
    f.resize(Math.max(0.01, n.w), Math.max(0.01, n.h));
    if (inAutoLayout)
        f.layoutSizingHorizontal = 'FIXED';
    if (inAutoLayout)
        f.layoutSizingVertical = 'FIXED';
    else
        placeRotated(f, n.x - origin.x, n.y - origin.y, n.w, n.h, n.rotation);
    f.visible = n.visible;
    f.clipsContent = n.clips;
    const fills = [];
    if (n.fill && n.gradient)
        fills.push(gradientPaint(n.gradient));
    else if (n.fill)
        fills.push({ type: 'SOLID', color: rgb(n.fill.color), opacity: n.fill.opacity });
    f.fills = fills;
    if (n.corner)
        f.cornerRadius = n.corner;
    if (n.stroke && n.stroke.target === 'border') {
        f.strokes = [{ type: 'SOLID', color: rgb(n.stroke.color), opacity: n.stroke.opacity }];
        f.strokeWeight = n.stroke.thickness;
        f.strokeAlign = 'OUTSIDE';
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
            const image = figma.createImage(figma.base64Decode(n.image.url.slice(n.image.url.indexOf(',') + 1)));
            img.fills = [{ type: 'IMAGE', imageHash: image.hash, scaleMode: n.image.scaleType === 'Fit' ? 'FIT' : n.image.scaleType === 'Crop' ? 'CROP' : n.image.scaleType === 'Tile' ? 'TILE' : 'FILL', opacity: n.image.opacity }];
        }
        else {
            img.fills = [{ type: 'SOLID', color: { r: 0.5, g: 0.5, b: 0.5 }, opacity: 0.3 }];
            img.dashPattern = [4, 3];
            img.strokes = [{ type: 'SOLID', color: { r: 0.6, g: 0.6, b: 0.6 } }];
        }
        if (n.corner)
            img.cornerRadius = n.corner;
        if (n.layout)
            img.layoutPositioning = 'ABSOLUTE';
    }
    if (n.text && n.text.content) {
        const t = figma.createText();
        f.appendChild(t);
        t.name = TEXT_LAYER;
        t.fontName = await loadFont(n.text);
        t.characters = n.text.rich ? n.text.content.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '') : n.text.content;
        t.fontSize = Math.max(1, n.text.size);
        t.lineHeight = { value: n.text.lineHeight * 100, unit: 'PERCENT' };
        t.fills = !n.fill && n.gradient ? [gradientPaint(n.gradient)] : [{ type: 'SOLID', color: rgb(n.text.color), opacity: n.text.opacity }];
        t.textAlignHorizontal = n.text.alignX === 'Left' ? 'LEFT' : n.text.alignX === 'Right' ? 'RIGHT' : 'CENTER';
        t.textAlignVertical = n.text.alignY === 'Top' ? 'TOP' : n.text.alignY === 'Bottom' ? 'BOTTOM' : 'CENTER';
        t.textAutoResize = 'NONE';
        const p = (_a = n.padding) !== null && _a !== void 0 ? _a : { top: 0, right: 0, bottom: 0, left: 0 };
        t.resize(Math.max(1, n.w - p.left - p.right), Math.max(1, n.h - p.top - p.bottom));
        if (n.layout)
            t.layoutPositioning = 'ABSOLUTE';
        t.x = p.left;
        t.y = p.top;
        if (n.stroke && n.stroke.target === 'text') {
            t.strokes = [{ type: 'SOLID', color: rgb(n.stroke.color), opacity: n.stroke.opacity }];
            t.strokeWeight = n.stroke.thickness;
            t.strokeAlign = 'OUTSIDE';
        }
    }
    // Children: in auto layout, Figma order is layout order (sort along the axis); otherwise draw order.
    let kids = n.children;
    if (n.layout) {
        const vertical = n.layout.direction === 'Vertical';
        kids = [...kids].sort((a, b) => (vertical ? a.y - b.y || a.x - b.x : a.x - b.x || a.y - b.y));
        f.layoutMode = vertical ? 'VERTICAL' : 'HORIZONTAL';
        f.itemSpacing = n.layout.gap;
        if (n.layout.kind === 'grid' || n.layout.wraps) {
            f.layoutWrap = 'WRAP';
            f.counterAxisSpacing = (_b = n.layout.gapCross) !== null && _b !== void 0 ? _b : n.layout.gap;
        }
        f.primaryAxisSizingMode = 'FIXED';
        f.counterAxisSizingMode = 'FIXED';
        f.primaryAxisAlignItems = H_ALIGN[vertical ? n.layout.alignY : n.layout.alignX];
        f.counterAxisAlignItems = H_ALIGN[vertical ? n.layout.alignX : n.layout.alignY];
        f.resize(Math.max(0.01, n.w), Math.max(0.01, n.h));
    }
    for (const c of kids)
        await build(c, f, { x: n.x, y: n.y }, !!n.layout);
    return f;
}
async function importDoc(doc) {
    if (doc.format !== 'forge-ui' || !doc.root)
        throw new Error('Not a Forge UI document (format "forge-ui").');
    if (doc.version > 1)
        throw new Error(`Forge UI document version ${doc.version} is newer than this plugin.`);
    const root = figma.createFrame();
    figma.currentPage.appendChild(root);
    root.name = `Forge: ${doc.root.name}${doc.device ? ` (${doc.device})` : ''}`;
    root.resize(doc.viewport.w, doc.viewport.h);
    root.clipsContent = true;
    root.fills = [{ type: 'SOLID', color: { r: 0.27, g: 0.31, b: 0.37 } }];
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
// ---- export
function decompose(node, origin) {
    const [[a, b, tx], [c, d, ty]] = node.relativeTransform;
    const w = 'width' in node ? node.width : 0;
    const h = 'height' in node ? node.height : 0;
    const cx = tx + (a * w) / 2 + (b * h) / 2;
    const cy = ty + (c * w) / 2 + (d * h) / 2;
    const rotation = round((Math.atan2(c, a) * 180) / Math.PI);
    void d;
    return { x: round(origin.x + cx - w / 2), y: round(origin.y + cy - h / 2), w: round(w), h: round(h), rotation };
}
function solid(paints) {
    var _a;
    if (!Array.isArray(paints))
        return null;
    const p = paints.find((x) => x.type === 'SOLID' && x.visible !== false);
    return p ? { color: hex(p.color), opacity: round((_a = p.opacity) !== null && _a !== void 0 ? _a : 1) } : null;
}
function gradient(paints) {
    if (!Array.isArray(paints))
        return null;
    const p = paints.find((x) => x.type === 'GRADIENT_LINEAR' && x.visible !== false);
    return p ? readGradient(p) : null;
}
function exportText(t, saved) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j;
    const font = t.fontName === figma.mixed ? { family: (_a = saved === null || saved === void 0 ? void 0 : saved.substitute) !== null && _a !== void 0 ? _a : 'Inter', style: 'Regular' } : t.fontName;
    const styleKey = font.style.toLowerCase().replace(/\s*italic\s*/, '').trim() || 'regular';
    const fill = solid(t.fills);
    const lh = t.lineHeight !== figma.mixed && t.lineHeight.unit === 'PERCENT' ? t.lineHeight.value / 100 : ((_b = saved === null || saved === void 0 ? void 0 : saved.lineHeight) !== null && _b !== void 0 ? _b : 1);
    return {
        content: t.characters,
        rich: false,
        // A changed family is reported as typed in Figma; Forge maps it to a Roblox Font.
        family: saved && font.family === saved.substitute ? saved.family : font.family,
        substitute: font.family,
        weight: (_c = WEIGHT_BY_STYLE[styleKey]) !== null && _c !== void 0 ? _c : 400,
        italic: /italic/i.test(font.style),
        size: t.fontSize === figma.mixed ? ((_d = saved === null || saved === void 0 ? void 0 : saved.size) !== null && _d !== void 0 ? _d : 14) : round(t.fontSize),
        lineHeight: lh,
        color: (_f = (_e = fill === null || fill === void 0 ? void 0 : fill.color) !== null && _e !== void 0 ? _e : saved === null || saved === void 0 ? void 0 : saved.color) !== null && _f !== void 0 ? _f : '#000000',
        opacity: (_g = fill === null || fill === void 0 ? void 0 : fill.opacity) !== null && _g !== void 0 ? _g : 1,
        alignX: t.textAlignHorizontal === 'LEFT' ? 'Left' : t.textAlignHorizontal === 'RIGHT' ? 'Right' : 'Center',
        alignY: t.textAlignVertical === 'TOP' ? 'Top' : t.textAlignVertical === 'BOTTOM' ? 'Bottom' : 'Center',
        wrapped: (_h = saved === null || saved === void 0 ? void 0 : saved.wrapped) !== null && _h !== void 0 ? _h : false,
        scaled: (_j = saved === null || saved === void 0 ? void 0 : saved.scaled) !== null && _j !== void 0 ? _j : false
    };
}
function exportNode(node, origin, parentPath) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o;
    if (node.name === TEXT_LAYER || node.name === IMAGE_LAYER)
        return null;
    const g = decompose(node, origin);
    const raw = node.getPluginData(KEY);
    const saved = raw ? JSON.parse(raw) : null;
    const isFrame = node.type === 'FRAME' || node.type === 'COMPONENT' || node.type === 'INSTANCE' || node.type === 'GROUP';
    const name = node.name;
    const path = saved && saved.name === name ? saved.path : parentPath ? `${parentPath}.${name}` : name;
    const fills = 'fills' in node ? node.fills : [];
    // A gradient fill keeps the Roblox base colour (the gradient multiplies BackgroundColor3).
    const fill = (_a = solid(fills)) !== null && _a !== void 0 ? _a : (gradient(fills) ? ((_b = saved === null || saved === void 0 ? void 0 : saved.fill) !== null && _b !== void 0 ? _b : { color: '#FFFFFF', opacity: 1 }) : null);
    let text = null;
    let stroke = null;
    const children = [];
    if (node.type === 'TEXT') {
        // A text layer the designer added directly: a TextLabel with no background.
        text = exportText(node, null);
    }
    else if (isFrame && 'children' in node) {
        const t = node.children.find((c) => c.name === TEXT_LAYER && c.type === 'TEXT');
        if (t) {
            text = exportText(t, (_c = saved === null || saved === void 0 ? void 0 : saved.text) !== null && _c !== void 0 ? _c : null);
            if (Array.isArray(t.strokes) && t.strokes.length && typeof t.strokeWeight === 'number') {
                const s = solid(t.strokes);
                if (s)
                    stroke = Object.assign(Object.assign({}, s), { thickness: round(t.strokeWeight), target: 'text' });
            }
        }
        for (const c of node.children) {
            const fc = exportNode(c, g.rotation ? { x: g.x, y: g.y } : { x: g.x, y: g.y }, path);
            if (fc)
                children.push(fc);
        }
    }
    if (!stroke && 'strokes' in node && Array.isArray(node.strokes) && node.strokes.length && node.type !== 'TEXT') {
        const s = solid(node.strokes);
        const weight = node.strokeWeight;
        if (s && typeof weight === 'number')
            stroke = Object.assign(Object.assign({}, s), { thickness: round(weight), target: 'border' });
    }
    let layout = null;
    if (node.type === 'FRAME' && node.layoutMode !== 'NONE' && node.layoutMode !== 'GRID') {
        const vertical = node.layoutMode === 'VERTICAL';
        const fromAlign = (v, axisX) => (v === 'CENTER' ? 'Center' : v === 'MAX' ? (axisX ? 'Right' : 'Bottom') : axisX ? 'Left' : 'Top');
        layout = Object.assign(Object.assign(Object.assign({ kind: (_e = (_d = saved === null || saved === void 0 ? void 0 : saved.layout) === null || _d === void 0 ? void 0 : _d.kind) !== null && _e !== void 0 ? _e : 'list', direction: vertical ? 'Vertical' : 'Horizontal', gap: round(node.itemSpacing) }, (node.layoutWrap === 'WRAP' && node.counterAxisSpacing != null ? { gapCross: round(node.counterAxisSpacing) } : {})), { alignX: fromAlign(vertical ? node.counterAxisAlignItems : node.primaryAxisAlignItems, true), alignY: fromAlign(vertical ? node.primaryAxisAlignItems : node.counterAxisAlignItems, false), wraps: node.layoutWrap === 'WRAP' }), (((_f = saved === null || saved === void 0 ? void 0 : saved.layout) === null || _f === void 0 ? void 0 : _f.cell) ? { cell: saved.layout.cell } : {}));
        // Keep the Forge shape when only Figma-only fields differ.
        if ((saved === null || saved === void 0 ? void 0 : saved.layout) && saved.layout.kind === 'grid')
            layout = Object.assign(Object.assign(Object.assign({}, saved.layout), { gap: layout.gap }), (layout.gapCross != null ? { gapCross: layout.gapCross } : {}));
    }
    const padding = node.type === 'FRAME' && (node.paddingTop || node.paddingRight || node.paddingBottom || node.paddingLeft) ? { top: round(node.paddingTop), right: round(node.paddingRight), bottom: round(node.paddingBottom), left: round(node.paddingLeft) } : null;
    const corner = 'cornerRadius' in node && typeof node.cornerRadius === 'number' ? round(node.cornerRadius) : 0;
    return {
        id: (_g = saved === null || saved === void 0 ? void 0 : saved.id) !== null && _g !== void 0 ? _g : 0,
        path,
        name,
        cls: (_h = saved === null || saved === void 0 ? void 0 : saved.cls) !== null && _h !== void 0 ? _h : (node.type === 'TEXT' ? 'TextLabel' : 'Frame'),
        x: g.x,
        y: g.y,
        w: g.w,
        h: g.h,
        rotation: g.rotation,
        visible: node.visible,
        clips: node.type === 'FRAME' ? node.clipsContent : false,
        fill: node.type === 'TEXT' ? null : fill,
        gradient: node.type === 'TEXT' ? null : (_j = gradient(fills)) !== null && _j !== void 0 ? _j : (text && !fill && 'children' in node ? gradient((_l = (_k = node.children.find((c) => c.name === TEXT_LAYER)) === null || _k === void 0 ? void 0 : _k.fills) !== null && _l !== void 0 ? _l : []) : null),
        corner,
        stroke,
        padding,
        layout,
        text,
        image: (_m = saved === null || saved === void 0 ? void 0 : saved.image) !== null && _m !== void 0 ? _m : null,
        props: (_o = saved === null || saved === void 0 ? void 0 : saved.props) !== null && _o !== void 0 ? _o : {},
        children
    };
}
function exportSelection() {
    const sel = figma.currentPage.selection[0];
    let root = sel !== null && sel !== void 0 ? sel : null;
    while (root && !root.getPluginData(DOC_KEY) && root.parent && root.parent.type !== 'PAGE')
        root = root.parent;
    if (!root || !root.getPluginData(DOC_KEY))
        throw new Error('Select a frame imported by Forge UI (or anything inside it).');
    const meta = JSON.parse(root.getPluginData(DOC_KEY));
    const children = [];
    if ('children' in root)
        for (const c of root.children) {
            const fc = exportNode(c, { x: 0, y: 0 }, '');
            if (fc)
                children.push(fc);
        }
    return Object.assign(Object.assign({ format: 'forge-ui', version: 1, story: meta.story }, (meta.device ? { device: meta.device } : {})), { viewport: meta.viewport, exportedAt: new Date().toISOString(), root: { id: meta.id, path: '', name: meta.name, cls: 'Frame', x: 0, y: 0, w: meta.viewport.w, h: meta.viewport.h, rotation: 0, visible: true, clips: true, fill: null, gradient: null, corner: 0, stroke: null, padding: null, layout: null, text: null, image: null, props: {}, children } });
}
figma.ui.onmessage = async (msg) => {
    var _a;
    try {
        if (msg.type === 'import') {
            const doc = JSON.parse((_a = msg.json) !== null && _a !== void 0 ? _a : '');
            const result = await importDoc(doc);
            figma.ui.postMessage(Object.assign({ type: 'imported' }, result));
            figma.notify(`Imported ${result.name}`);
        }
        else if (msg.type === 'export') {
            const doc = exportSelection();
            figma.ui.postMessage({ type: 'exported', json: JSON.stringify(doc, null, 2), story: doc.story });
        }
        else if (msg.type === 'close') {
            figma.closePlugin();
        }
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        figma.ui.postMessage({ type: 'error', message });
        figma.notify(message, { error: true });
    }
};
