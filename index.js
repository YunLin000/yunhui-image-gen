// ============================================================
//  云绘生图（Yunhui Image Generation）— SillyTavern 扩展
//  通过云绘（ComfyUI→OpenAI 兼容桥）自动捕获标签生图
//  v2.0：全屏子面板 + 可拖拽悬浮按钮 + 自动生图模式骨架
//  作者: MOMO  版本: 2.0.0
// ============================================================

import { extension_settings, getContext } from '../../../extensions.js';
import {
    saveSettingsDebounced,
    eventSource,
    event_types,
    updateMessageBlock,
    appendMediaToMessage,
    substituteParams,
    getCurrentChatId,
} from '../../../../script.js';
import { regexFromString, saveBase64AsFile } from '../../../utils.js';
import { humanizedDateTime } from '../../../RossAscends-mods.js';

// ---------------- 常量 ----------------
const MODULE_NAME = 'yunhui_image_gen';
const EXT_FOLDER = '/scripts/extensions/third-party/yunhui-image-gen';
const GENERATING_FLAG = new Set(); // 防重入：正在生成图片的消息 mesId 集合
let currentChatId = null; // 切聊天保护
let yhSwipedAt = 0; // 滑动时间标记（防卡片头部滑动误触 click）
let yhTouchAt = 0; // 最后一次触摸时间（移动端 toggle 统一交给 touchend 处理）
let yhMouseDown = null; // 桌面端鼠标按下坐标（拖动/划选不触发卡片交互）
let yhDialogOpenedAt = 0; // 弹窗创建时间（防同一次点击穿透到弹窗按钮）
let fsOpenedAt = 0; // 看图模式打开时间（防打开瞬间被残留点击立即关闭）
let yhPanelOpenedAt = 0; // 面板打开时间（防打开瞬间被残留点击立即关闭）

// ---------------- 默认设置 ----------------
const defaultSettings = {
    activeTab: 'yh_tab_pane1', // 面板默认 tab（持久化记忆）
    enabled: false,
    silent: false,
    baseUrl: '',
    apiKey: '',
    model: '',
    width: 768,
    height: 1024,
    timeout: 360, // 秒，默认 6 分钟
    negativePrompt: '',
    stylePrompt: '',
    stylePrepend: false,
    presets: [], // [{name, content}]
    models: [], // 生图模型列表（持久化，重启后可立即回显，不用等拉取）
    captureRegex: '/<pic[^>]*\\sprompt="([^"]*)"[^>]*?>/g',
    injectEnabled: true,
    injectPrompt: `<image_generation>
You must insert a <pic prompt="example prompt"> at end of the reply. Prompts are used for stable diffusion image generation, based on the plot and character to output appropriate prompts to generate captivating images.
</image_generation>`,
    injectPosition: 'deep_system',
    injectDepth: 0,
    insertType: 'replace', // replace | inline
    hideTagsStream: true, // 流式隐藏 <local_img> 标签（注册 ST 正则脚本，显示层生效）
    fabTop: null, // 悬浮按钮位置（top 像素，可拖拽记忆；null=居中）
    fabVisible: true, // 是否显示悬浮按钮（扩展面板入口可开关）
    // ===== v2.0 自动生图模式（模式2）=====
    autoMode: {
        enabled: false,            // 自动生图模式开关（与标签模式互斥）
        imageCount: 3,             // 每次生成张数
        saveMode: false,           // 省图模式（仅场景/服饰变化时生图）
        cardExpanded: false,       // 卡片默认展开
        cardLayout: 'carousel',    // carousel 左右翻页 | vertical 竖排平铺 | grid 网格
        source: 'horae',           // horae Horae时光记忆（默认） | custom 云绘自定义
        keepDays: 1,               // 总结快照存储天数
        useChatModel: true,        // true 用聊天模型，false 用辅助 API
        auxUrl: '',                // 辅助 LLM 地址
        auxKey: '',                // 辅助 LLM Key
        auxModel: '',              // 辅助 LLM 模型
        auxModels: [],             // 辅助模型列表（持久化，回显用）
        historyCount: 10,          // 上传给辅助 LLM 的最近聊天记录条数
        manualCount: 30,           // 手动总结时取的对话条数（持久化记忆）
        customColumns: [           // 总结表格列定义（可自定义，贯穿提示词/UI/快照）
            { name: '发型', rule: '' },
            { name: '妆容', rule: '' },
            { name: '长相', rule: '' },
            { name: '穿着', rule: '' },
            { name: '状态', rule: '' },
            { name: '场景', rule: '' },
            { name: '氛围', rule: '' },
            { name: '时间', rule: '' },
        ],
        summaryPrompt: '',         // 总结提示词工程（留空用默认）
        promptRules: '',           // 生图提示词生成规则（留空用默认）
    },
};

// ============================================================
//  设置管理
// ============================================================
function getSettings() {
    if (!extension_settings[MODULE_NAME]) extension_settings[MODULE_NAME] = {};
    const s = extension_settings[MODULE_NAME];
    for (const k of Object.keys(defaultSettings)) {
        if (s[k] === undefined) s[k] = structuredClone(defaultSettings[k]);
    }
    // autoMode 是嵌套对象，需逐键补齐
    if (typeof s.autoMode !== 'object' || s.autoMode === null) s.autoMode = {};
    for (const k of Object.keys(defaultSettings.autoMode)) {
        if (s.autoMode[k] === undefined) s.autoMode[k] = structuredClone(defaultSettings.autoMode[k]);
    }
    return s;
}

function loadSettings() {
    getSettings(); // 确保初始化
    updateUI();
}

// ============================================================
//  UI 构建
// ============================================================
async function createSettings() {
    if (!$('#yunhui_image_gen_container').length) {
        $('#extensions_settings2').append(
            `<div id="yunhui_image_gen_container" class="extension_container"></div>`,
        );
    }
    const html = await $.get(`${EXT_FOLDER}/settings.html`);
    $('#yunhui_image_gen_container').empty().append(html);

    // 全屏子面板：挂到 body（默认隐藏）
    if (!$('#yh_panel_overlay').length) {
        const panelHtml = await $.get(`${EXT_FOLDER}/panel.html`);
        $('body').append(panelHtml);
    }

    bindEvents();
    // 模型下拉：先用持久化列表回显（刷新后不空白），再异步拉取更新
    const s0 = getSettings();
    if (s0.models?.length) fillModelSelect(s0.models);
    if (s0.autoMode?.auxModels?.length) fillAuxModelSelect(s0.autoMode.auxModels);
    updateUI();
    syncHideTagsRegex(); // 注册流式隐藏正则
    // 启动时自动拉一次模型（生图 + 辅助）
    if (s0.baseUrl) refreshModels();
    if (s0.autoMode?.auxUrl) refreshAuxModels();
}

function updateUI() {
    const s = getSettings();
    const set = (id, val) => { const el = $(`#${id}`); if (el.length) el.val(val); };
    const check = (id, val) => { const el = $(`#${id}`); if (el.length) el.prop('checked', val); };

    check('yh_enabled', s.enabled);
    check('yh_silent', s.silent);
    set('yh_base_url', s.baseUrl);
    set('yh_api_key', s.apiKey);
    set('yh_width', s.width);
    set('yh_height', s.height);
    set('yh_timeout', s.timeout);
    set('yh_negative', s.negativePrompt);
    set('yh_style', s.stylePrompt);
    check('yh_style_prepend', s.stylePrepend);
    set('yh_capture_regex', s.captureRegex);
    check('yh_inject_enabled', s.injectEnabled);
    check('yh_hide_tags_stream', s.hideTagsStream);
    set('yh_inject_prompt', s.injectPrompt);
    set('yh_inject_position', s.injectPosition);
    set('yh_inject_depth', s.injectDepth);
    $(`input[name="yh_insert_type"][value="${s.insertType}"]`).prop('checked', true);
    refreshPresetSelect();

    // ===== v2.0 自动生图设置 =====
    const a = s.autoMode;
    check('yh_auto_enabled', a.enabled);
    set('yh_auto_count', a.imageCount);
    set('yh_auto_history', a.historyCount);
    set('yh_manual_count', a.manualCount || 30);
    check('yh_auto_save_mode', a.saveMode);
    check('yh_card_expanded', a.cardExpanded);
    set('yh_card_layout', a.cardLayout);
    set('yh_auto_source', a.source);
    set('yh_auto_keep', a.keepDays);
    check('yh_auto_chat_model', a.useChatModel);
    set('yh_aux_url', a.auxUrl);
    set('yh_aux_key', a.auxKey);
    set('yh_aux_model', a.auxModel);
    set('yh_summary_prompt', a.summaryPrompt);
    set('yh_prompt_rules', a.promptRules);

    renderColumnsUI();
    renderTableEditor();
    check('yh_fab_visible', s.fabVisible);
    $('#yh_fab').toggle(!!s.fabVisible); // 同步悬浮按钮显示状态
    updateDisabledState();
    updateStatusBar();
}

// 互斥灰化：对方模式启用时，本 tab 参数区变灰停用
function updateDisabledState() {
    const s = getSettings();
    const en1 = !!s.enabled;
    const en2 = !!s.autoMode?.enabled;
    // 参数区灰化
    $('#yh_pane1_body').toggleClass('disabled', en2);   // 自动启用 → 标签参数灰
    $('#yh_pane2_body').toggleClass('disabled', en1);   // 标签启用 → 自动参数灰
    // tab 按钮也灰（视觉提示该模式已停用）
    $('.yh-panel-tab[data-yh-tab="yh_tab_pane1"]').toggleClass('yh-tab-disabled', en2);
    $('.yh-panel-tab[data-yh-tab="yh_tab_pane2"]').toggleClass('yh-tab-disabled', en1);
}

// 扩展面板入口的状态行
function updateStatusBar() {
    const s = getSettings();
    const auto = !!s.autoMode?.enabled;
    const modeLabel = auto ? '自动生图' : (s.enabled ? '标签生图' : '未启用');
    $('#yh_status_mode').text(modeLabel);
    $('#yh_status_enabled').text((auto || s.enabled) ? '✅ 启用' : '⭕ 停用');
}

// ============================================================
//  事件绑定（每个控件 → 持久化）
// ============================================================
function bindEvents() {
    const s = getSettings();
    const persist = (id, key, isCheck, isNum) => {
        $(`#${id}`).on('input change', function () {
            let v = isCheck ? $(this).prop('checked') : $(this).val();
            if (isNum) v = parseInt(String(v)) || 0;
            s[key] = v;
            saveSettingsDebounced();
        });
    };

    persist('yh_enabled', 'enabled', true);
    // 互斥：启用标签生图 → 自动生图停用
    $('#yh_enabled').on('change', function () {
        s.enabled = $(this).prop('checked');  // 显式同步（persist 也设，保险）
        if ($(this).prop('checked')) {
            s.autoMode.enabled = false;
            $('#yh_auto_enabled').prop('checked', false);
        }
        saveSettingsDebounced();
        updateDisabledState();
        updateStatusBar();
    });
    persist('yh_silent', 'silent', true);
    persist('yh_base_url', 'baseUrl');
    persist('yh_api_key', 'apiKey');
    persist('yh_width', 'width', false, true);
    persist('yh_height', 'height', false, true);
    // 尺寸变更时同步更新正则占位符尺寸（保持三处一致）
    $('#yh_width').on('change', syncHideTagsRegex);
    $('#yh_height').on('change', syncHideTagsRegex);
    persist('yh_timeout', 'timeout', false, true);
    persist('yh_negative', 'negativePrompt');
    persist('yh_style', 'stylePrompt');
    persist('yh_style_prepend', 'stylePrepend', true);
    persist('yh_capture_regex', 'captureRegex');
    persist('yh_inject_enabled', 'injectEnabled', true);
    $('#yh_hide_tags_stream').on('input change', function () {
        s.hideTagsStream = $(this).prop('checked');
        saveSettingsDebounced();
        syncHideTagsRegex();
    });
    persist('yh_inject_prompt', 'injectPrompt');
    persist('yh_inject_position', 'injectPosition');
    persist('yh_inject_depth', 'injectDepth', false, true);

    $('input[name="yh_insert_type"]').on('change', function () {
        s.insertType = $(this).val();
        saveSettingsDebounced();
    });

    // 模型刷新 + 模型选择
    $('#yh_refresh_models').on('click', refreshModels);
    $('#yh_model').on('change', function () { s.model = $(this).val(); saveSettingsDebounced(); });

    // 预设 CRUD
    $('#yh_preset_add').on('click', addPreset);
    $('#yh_preset_update').on('click', updatePreset);
    $('#yh_preset_delete').on('click', deletePreset);
    $('#yh_preset_select').on('change', function () {
        const name = $(this).val();
        const p = s.presets.find(x => x.name === name);
        if (p) { $('#yh_style').val(p.content); }
    });

    // ===== v2.0 自动生图设置 =====
    const a = s.autoMode;
    const persistA = (id, key, isCheck, isNum) => {
        $(`#${id}`).on('input change', function () {
            let v = isCheck ? $(this).prop('checked') : $(this).val();
            if (isNum) v = parseInt(String(v)) || 0;
            a[key] = v;
            saveSettingsDebounced();
            updateStatusBar();
        });
    };
    // 互斥：启用自动生图 → 标签生图停用
    $('#yh_auto_enabled').on('change', function () {
        s.autoMode.enabled = $(this).prop('checked');  // ← 之前漏了这行，导致 en2 不更新、标签不灰
        if ($(this).prop('checked')) {
            s.enabled = false;
            $('#yh_enabled').prop('checked', false);
        }
        saveSettingsDebounced();
        updateDisabledState();
        updateStatusBar();
    });
    persistA('yh_auto_count', 'imageCount', false, true);
    persistA('yh_auto_history', 'historyCount', false, true);
    persistA('yh_auto_save_mode', 'saveMode', true);
    persistA('yh_card_expanded', 'cardExpanded', true);
    persistA('yh_card_layout', 'cardLayout');
    persistA('yh_auto_source', 'source');
    persistA('yh_auto_keep', 'keepDays', false, true);
    persistA('yh_auto_chat_model', 'useChatModel', true);
    persistA('yh_aux_url', 'auxUrl');
    persistA('yh_aux_key', 'auxKey');
    persistA('yh_aux_model', 'auxModel');
    // 总结列管理
    $('#yh_add_col').on('click', addColumn);
    $('#yh_columns_list').on('pointerdown', '.yh-col-del', function (e) {
        e.stopPropagation();
        removeColumn(parseInt($(this).attr('data-idx')));
    });
    $('#yh_columns_list').on('change', '.yh-col-rule', function () {
        const idx = parseInt($(this).attr('data-idx'));
        const a = getSettings().autoMode;
        if (a.customColumns && a.customColumns[idx]) {
            a.customColumns[idx].rule = $(this).val();
            saveSettingsDebounced();
        }
    });
    // 列提取规则：点击弹大编辑窗（看全貌 + 改，长文本不再截断）
    $('#yh_columns_list').on('click', '.yh-col-rule', function () {
        const idx = parseInt($(this).attr('data-idx'));
        const a = getSettings().autoMode;
        const col = a.customColumns && a.customColumns[idx];
        if (!col) return;
        const self = this;
        showBigEditor('列「' + col.name + '」· 提取规则', col.rule || '', function (val) {
            col.rule = val;
            saveSettingsDebounced();
            $(self).val(val);
        });
    });
    // 表格单元格：点击弹大编辑窗（改完点"保存表格"统一写回）
    $('#yh_table_editor').on('click', '.yh-cell', function () {
        const role = $(this).attr('data-role');
        const col = $(this).attr('data-col');
        const self = this;
        showBigEditor(role + ' · ' + col, $(this).val() || '', function (val) {
            $(self).val(val);
        });
    });
    // 表格编辑
    $('#yh_table_save').on('pointerdown', function (e) { e.stopPropagation(); saveTableEditor(); });
    $('#yh_table_refresh').on('pointerdown', function (e) { e.stopPropagation(); renderTableEditor(); });

    persistA('yh_summary_prompt', 'summaryPrompt');
    persistA('yh_prompt_rules', 'promptRules');
    // 提示词工程两个输入框：点击弹大编辑窗（看全貌 + 改 + 确定/取消）
    $('#yh_summary_prompt, #yh_prompt_rules').on('click', function (e) {
        e.preventDefault();
        const isSummary = $(this).attr('id') === 'yh_summary_prompt';
        const a = getSettings().autoMode;
        const key = isSummary ? 'summaryPrompt' : 'promptRules';
        const self = this;
        showBigEditor(
            isSummary ? '总结提示词（system prompt）※留空用内置默认，支持 {{宏}}' : '生图提示词生成规则（追加）※留空用默认',
            a[key] || '',
            function (val) {
                a[key] = val;
                saveSettingsDebounced();
                $(self).val(val);
            }
        );
    });

    // 悬浮按钮显示/隐藏开关
    $('#yh_fab_visible').on('change', function () {
        s.fabVisible = $(this).prop('checked');
        saveSettingsDebounced();
        $('#yh_fab').toggle(s.fabVisible);
    });

    // #yh_open_panel：按下只记录 → 抬起判定（滑动不触发打开；capture 阶段防 click 被父层吞）
    let yhOpenPending = null;
    document.addEventListener('pointerdown', function (e) {
        if (e.target.closest('#yh_open_panel')) {
            yhOpenPending = { x: e.clientX, y: e.clientY, id: e.pointerId };
        }
    }, true);
    document.addEventListener('pointerup', function (e) {
        const p = yhOpenPending;
        yhOpenPending = null;
        if (!p || p.id !== e.pointerId) return;
        if (Math.abs(e.clientX - p.x) > 12 || Math.abs(e.clientY - p.y) > 12) return; // 滑动过 → 不打开
        // 延迟 60ms 再打开：让本次点击的合成 click 先派发完（否则 click 会落到刚出现的面板元素上 → 面板里的东西被跟着点击）
        setTimeout(openPanel, 60);
    }, true);
    document.addEventListener('pointercancel', function () { yhOpenPending = null; }, true);
    $('#yh_panel_close').on('click', closePanel);
    $('.yh-panel-tab').on('click', function () { switchTab($(this).data('yh-tab')); });
    // 点遮罩空白处关闭（点面板内部不关）；刚打开时忽略残留点击
    $('#yh_panel_overlay').on('click', function (e) {
        if (e.target === this) {
            if (Date.now() - yhPanelOpenedAt < 350) return;
            closePanel();
        }
    });
    // 手动总结
    $('#yh_manual_summary').on('click', function () {
        setTimeout(() => runManualSummary($('#yh_manual_count').val()), 60); // 延迟 60ms 防穿透
    });
    $('#yh_manual_count').on('change', function () {
        const v = Math.max(1, Math.min(200, parseInt($(this).val()) || 30));
        $(this).val(v);
        getSettings().autoMode.manualCount = v;
        saveSettingsDebounced();
    });
    // 辅助模型刷新
    $('#yh_aux_refresh').on('click', refreshAuxModels);
    // 公共区折叠切换
    $('#yh_common_toggle').on('click', function () {
        $('#yh_common_content').slideToggle(150);
        $(this).find('.yh-common-chevron').toggleClass('fa-chevron-down fa-chevron-up');
    });
}

// ============================================================
//  模型下拉填充（用持久化列表回显，避免刷新后空白要手动选）
// ============================================================
function fillModelSelect(models) {
    const s = getSettings();
    const $sel = $('#yh_model');
    if (!$sel.length || !Array.isArray(models) || !models.length) return;
    $sel.empty();
    models.forEach(m => $sel.append(`<option value="${escapeAttr(m)}">${escapeText(m)}</option>`));
    if (s.model && models.includes(s.model)) $sel.val(s.model);
    else { s.model = models[0]; $sel.val(s.model); saveSettingsDebounced(); }
}

function fillAuxModelSelect(models) {
    const s = getSettings();
    const a = s.autoMode;
    const $sel = $('#yh_aux_model');
    if (!$sel.length || !Array.isArray(models) || !models.length) return;
    $sel.empty();
    models.forEach(m => $sel.append(`<option value="${escapeAttr(m)}">${escapeText(m)}</option>`));
    if (a.auxModel && models.includes(a.auxModel)) $sel.val(a.auxModel);
    else { a.auxModel = models[0]; $sel.val(a.auxModel); saveSettingsDebounced(); }
}

// ============================================================
//  模型刷新（GET /v1/models）
// ============================================================
async function refreshModels() {
    const s = getSettings();
    if (!s.baseUrl) { toastr.warning('请先填写云绘地址'); return; }
    const $sel = $('#yh_model');
    $sel.empty().append('<option value="">加载中...</option>');
    try {
        const url = s.baseUrl.replace(/\/+$/, '') + '/models';
        const res = await fetch(url, {
            headers: s.apiKey ? { 'Authorization': `Bearer ${s.apiKey}` } : {},
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const models = (data.data || []).map(m => m.id).filter(Boolean);
        if (models.length === 0) {
            $sel.empty().append('<option value="">（无可用工作流）</option>');
            toastr.warning('未获取到模型，请在云绘导入工作流');
        } else {
            s.models = models; // 持久化列表，重启后可直接回显
            saveSettingsDebounced();
            fillModelSelect(models);
        }
    } catch (e) {
        // 拉取失败：回退到缓存列表（有就用），否则提示
        if (s.models?.length) {
            fillModelSelect(s.models);
            toastr.warning('获取模型失败，使用缓存列表');
        } else {
            $sel.empty().append('<option value="">（获取失败）</option>');
            toastr.error(`获取模型失败: ${e.message}`);
        }
    }
}

// ============================================================
//  辅助 LLM 模型刷新（GET {auxUrl}/models）
// ============================================================
async function refreshAuxModels() {
    const s = getSettings();
    const a = s.autoMode;
    if (!a.auxUrl) { toastr.warning('请先填写辅助模型地址'); return; }
    const $sel = $('#yh_aux_model');
    $sel.empty().append('<option value="">加载中...</option>');
    try {
        const url = a.auxUrl.replace(/\/+$/, '') + '/models';
        const res = await fetch(url, {
            headers: a.auxKey ? { 'Authorization': `Bearer ${a.auxKey}` } : {},
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const models = (data.data || []).map(m => m.id).filter(Boolean);
        if (models.length === 0) {
            $sel.empty().append('<option value="">（无可用模型）</option>');
            toastr.warning('未获取到辅助模型');
        } else {
            a.auxModels = models; // 持久化列表，重启后可直接回显
            saveSettingsDebounced();
            fillAuxModelSelect(models);
        }
    } catch (e) {
        // 拉取失败：回退到缓存列表（有就用），否则提示
        if (a.auxModels?.length) {
            fillAuxModelSelect(a.auxModels);
            toastr.warning('获取辅助模型失败，使用缓存列表');
        } else {
            $sel.empty().append('<option value="">（获取失败）</option>');
            toastr.error(`获取辅助模型失败: ${e.message}`);
        }
    }
}

// ============================================================
//  画风预设 CRUD
// ============================================================
function refreshPresetSelect() {
    const s = getSettings();
    const $sel = $('#yh_preset_select');
    $sel.empty();
    if (s.presets.length === 0) {
        $sel.append('<option value="">（暂无预设）</option>');
    } else {
        s.presets.forEach(p => $sel.append(`<option value="${escapeAttr(p.name)}">${escapeText(p.name)}</option>`));
    }
}

function addPreset() {
    const content = $('#yh_style').val();
    if (!content.trim()) { toastr.warning('画风词为空'); return; }
    const name = prompt('请输入预设名称：');
    if (!name || !name.trim()) return;
    const s = getSettings();
    if (s.presets.find(p => p.name === name.trim())) { toastr.error('预设名称已存在'); return; }
    s.presets.push({ name: name.trim(), content });
    saveSettingsDebounced();
    refreshPresetSelect();
    $('#yh_preset_select').val(name.trim());
    toastr.success(`已新建预设「${name.trim()}」`);
}

function updatePreset() {
    const s = getSettings();
    const name = $('#yh_preset_select').val();
    if (!name) { toastr.warning('请先选择预设'); return; }
    const content = $('#yh_style').val();
    const p = s.presets.find(x => x.name === name);
    if (!p) return;
    p.content = content;
    saveSettingsDebounced();
    toastr.success(`已更新预设「${name}」`);
}

function deletePreset() {
    const s = getSettings();
    const name = $('#yh_preset_select').val();
    if (!name) { toastr.warning('请先选择预设'); return; }
    if (!confirm(`删除预设「${name}」？`)) return;
    s.presets = s.presets.filter(x => x.name !== name);
    saveSettingsDebounced();
    refreshPresetSelect();
    if (s.presets.length) $('#yh_preset_select').val(s.presets[0].name).trigger('change');
    toastr.success(`已删除预设「${name}」`);
}

// ============================================================
//  提示词注入 + REPLACE 还原（CHAT_COMPLETION_PROMPT_READY）
// ============================================================
eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, async function (eventData) {
    const s = getSettings();
    if (!s.enabled) return;

    // REPLACE 模式：把已替换的 <img data-yh-gen> 还原回原始标签
    if (s.insertType === 'replace' && Array.isArray(eventData?.chat)) {
        for (const entry of eventData.chat) {
            if (entry && typeof entry.content === 'string' && entry.content.includes('data-yh-gen=')) {
                entry.content = restoreTags(entry.content);
            }
        }
    }

    // 提示词注入
    if (!s.injectEnabled || !s.injectPrompt) return;
    const role = s.injectPosition === 'deep_user' ? 'user'
        : s.injectPosition === 'deep_assistant' ? 'assistant' : 'system';
    const prompt = substituteParams(s.injectPrompt);
    const depth = s.injectDepth || 0;
    if (depth === 0) eventData.chat.push({ role, content: prompt });
    else eventData.chat.splice(-depth, 0, { role, content: prompt });
});

// ============================================================
//  标签捕获 → 生图 → 插入（MESSAGE_RECEIVED）
// ============================================================
eventSource.on(event_types.MESSAGE_RECEIVED, handleMessageReceived);

async function handleMessageReceived() {
    const s = getSettings();
    if (!s.enabled && !s.autoMode?.enabled) return; // 两模式都没启用则跳过

    const context = getContext();
    const message = context.chat[context.chat.length - 1];
    if (!message || message.is_user) return;

    currentChatId = getCurrentChatId();

    // 模式2 自动生图（互斥：模式2 启用走自动流程，不处理标签捕获）
    if (s.autoMode?.enabled) {
        return handleAutoMode(message, context);
    }

    // 解析正则
    let regex;
    try {
        regex = regexFromString(s.captureRegex);
        if (!regex) throw new Error('空正则');
    } catch (e) {
        console.error(`[${MODULE_NAME}] 正则无效:`, s.captureRegex, e);
        return;
    }

    let matches;
    try {
        matches = regex.global ? [...message.mes.matchAll(regex)] : (message.mes.match(regex) ? [message.mes.match(regex)] : []);
    } catch (e) {
        console.error(`[${MODULE_NAME}] 正则匹配失败:`, e);
        return;
    }

    if (matches.length === 0) return;

    const mesId = context.chat.length - 1;
    if (GENERATING_FLAG.has(mesId)) return; // 防重入
    GENERATING_FLAG.add(mesId);

    // 延迟执行，确保消息先渲染
    setTimeout(async () => {
        try {
            const msgEl = $(`.mes[mesid="${mesId}"]`);

            // ===== 阶段1：批量占位（同步，所有标签一次性替换为占位符，不裸露）=====
            const queue = [];
            for (let i = 0; i < matches.length; i++) {
                const prompt = typeof matches[i]?.[1] === 'string' ? matches[i][1] : '';
                const originalTag = typeof matches[i]?.[0] === 'string' ? matches[i][0] : '';
                if (!prompt.trim()) continue;

                if (s.insertType === 'replace' && originalTag) {
                    const placeholder = makePlaceholder(originalTag, s.width, s.height);
                    if (message.mes.includes(originalTag)) {
                        message.mes = message.mes.replace(originalTag, placeholder);
                        queue.push({ prompt, originalTag, placeholder });
                    }
                } else {
                    // INLINE 模式：不提前占位（底部追加），直接入队列
                    queue.push({ prompt, originalTag, placeholder: null });
                }
            }
            // REPLACE 模式：一次渲染，所有占位符立刻显示
            if (s.insertType === 'replace') {
                updateMessageBlock(mesId, message);
            }

            // ===== 阶段2：逐个生成图片，替换对应占位符 =====
            let done = 0;
            for (const item of queue) {
                // 切聊天保护
                if (getCurrentChatId() !== currentChatId) {
                    console.warn(`[${MODULE_NAME}] 聊天已切换，丢弃剩余图片`);
                    if (!s.silent) toastr.warning('聊天已切换，生图已取消');
                    break;
                }
                done++;
                if (!s.silent) toastr.info(`生成中 ${done}/${queue.length}...`);
                const url = await generateImage(item.prompt);

                if (!url) {
                    // 失败：占位还原为原始标签（不吞标签）
                    if (item.placeholder && message.mes.includes(item.placeholder)) {
                        message.mes = message.mes.replace(item.placeholder, item.originalTag);
                        updateMessageBlock(mesId, message);
                    }
                    continue;
                }

                if (s.insertType === 'replace') {
                    insertReplace(message, item.placeholder, url, item.prompt, mesId, context);
                } else {
                    await insertInline(message, url, item.prompt, msgEl, context);
                }
            }
            await context.saveChat();
            if (!s.silent) toastr.success(`${queue.length} 张图片生成完成`);
        } catch (e) {
            console.error(`[${MODULE_NAME}] 生图错误:`, e);
            toastr.error(`生图失败: ${e.message}`); // 错误提示永远保留
        } finally {
            GENERATING_FLAG.delete(mesId);
        }
    }, 50);
}

// ============================================================
//  模式2：自动生图（取对话+Horae state → LLM 总结+生图提示词 → 生图 → 贴消息末尾）
//  第 2 期：核心流程 + 简单图片展示（第 3 期做完整卡片：翻页/平铺/网格+按钮）
// ============================================================
const YH_DEFAULT_COLUMNS = ['发型', '妆容', '长相', '穿着', '状态', '场景', '氛围', '时间'];

// 手动总结：取最近 N 条对话 → LLM 总结 → 存快照 → 刷新表格（不生图）
// 用途：自动总结失效/不到位时，用户主动补总结
async function runManualSummary(count) {
    const s = getSettings();
    const a = s.autoMode;
    const context = getContext();
    if (!context.chat || !context.chat.length) { if (!s.silent) toastr.warning('当前没有对话可总结'); return; }
    const n = Math.max(1, Math.min(200, parseInt(count) || 30));
    const $btn = $('#yh_manual_summary');
    if ($btn.prop('disabled')) return;
    const origText = $btn.html();
    $btn.prop('disabled', true).html('⏳ 总结中...');
    if (!s.silent) toastr.info(`正在总结最近 ${n} 条对话...`);
    try {
        const recentChat = getRecentMessages(context.chat, n);
        const horaeState = (a.source === 'horae' && typeof window.Horae?.getLatestState === 'function') ? safeHoraeState() : null;
        const snapshots = getSnapshots(context);
        const cols = (a.customColumns?.length ? a.customColumns : YH_DEFAULT_COLUMNS.map(nm => ({ name: nm })));
        const sysPrompt = buildAutoSystemPrompt(cols, snapshots, horaeState, a);
        const userPrompt = buildAutoUserPrompt(recentChat, a);
        let rawOut = '';
        if (a.useChatModel) {
            rawOut = await context.generateQuietPrompt({ quietPrompt: userPrompt, systemPrompt: sysPrompt });
        } else {
            rawOut = await callAuxLLM(a, sysPrompt, userPrompt);
        }
        console.log(`[${MODULE_NAME}] 手动总结 LLM 原始输出:`, String(rawOut).slice(0, 800));
        const result = parseLLMJson(rawOut);
        if (!result) { if (!s.silent) toastr.error('总结失败：LLM 返回无法解析（按 F12 看"手动总结 LLM 原始输出"）'); return; }
        let table = (result.table && typeof result.table === 'object' && Object.keys(result.table).length) ? result.table : null;
        if (!table && horaeState) {
            table = buildFallbackTable(horaeState);
            if (table && Object.keys(table).length) if (!s.silent) toastr.info('LLM 未返回表格，已用 Horae 状态生成兜底表格');
        }
        if (!table || !Object.keys(table).length) { if (!s.silent) toastr.warning('LLM 未返回有效表格，总结失败'); return; }
        const storyDate = result.story_date || horaeState?.story_date || '第一天';
        await updateSnapshots(context, table, storyDate, a.keepDays);
        renderTableEditor();
        if (!s.silent) toastr.success(`✅ 总结完成（${Object.keys(table).length} 个角色，已写入最新快照）`);
    } catch (e) {
        console.error(`[${MODULE_NAME}] 手动总结失败:`, e);
        if (!s.silent) toastr.error(`总结失败: ${e.message || e}`);
    } finally {
        $btn.prop('disabled', false).html(origText);
    }
}

async function handleAutoMode(message, context) {
    const s = getSettings();
    const a = s.autoMode;
    const mesId = context.chat.length - 1;
    if (GENERATING_FLAG.has(mesId)) return;
    GENERATING_FLAG.add(mesId);

    setTimeout(async () => {
        try {
            const msgEl = $(`.mes[mesid="${mesId}"]`);
            if (getCurrentChatId() !== currentChatId) {
                console.warn(`[${MODULE_NAME}] 聊天已切换，取消自动生图`);
                return;
            }

            // 1. 取输入
            const recentChat = getRecentMessages(context.chat, a.historyCount || 10);
            const horaeState = (a.source === 'horae' && typeof window.Horae?.getLatestState === 'function')
                ? safeHoraeState() : null;
            const snapshots = getSnapshots(context);

            // 2. 构造 prompt
            const sysPrompt = buildAutoSystemPrompt((a.customColumns?.length ? a.customColumns : YH_DEFAULT_COLUMNS.map(n => ({ name: n }))), snapshots, horaeState, a);
            const userPrompt = buildAutoUserPrompt(recentChat, a);

            // 3. LLM 调用（聊天模型 or 辅助 API）
            let rawOut = '';
            if (a.useChatModel) {
                rawOut = await context.generateQuietPrompt({
                    quietPrompt: userPrompt,
                    systemPrompt: sysPrompt,
                });
            } else {
                rawOut = await callAuxLLM(a, sysPrompt, userPrompt);
            }

            // 4. 解析 JSON（完整输出进 console 便于排查）
            console.log(`[${MODULE_NAME}] 模式2 LLM 原始输出:`, String(rawOut).slice(0, 800));
            const result = parseLLMJson(rawOut);
            if (!result || !Array.isArray(result.prompts) || result.prompts.length === 0) {
                if (!s.silent) toastr.warning('自动生图：LLM 未返回有效提示词');
                console.warn(`[${MODULE_NAME}] LLM 输出解析失败:`, String(rawOut).slice(0, 300));
                return;
            }

            // 5. 快照存储（按天）——story_date 兜底：LLM 没给就用 Horae 的，再不行用默认
            const storyDate = result.story_date || horaeState?.story_date || '第一天';
            let finalTable = result.table && typeof result.table === 'object' ? result.table : null;
            if (finalTable && !Object.keys(finalTable).length) finalTable = null;
            // LLM 没返回 table（或空）→ 用 Horae state 构造兜底表格（保证表格区有数据）
            if (!finalTable && horaeState) {
                finalTable = buildFallbackTable(horaeState);
                if (finalTable && Object.keys(finalTable).length) {
                    if (!s.silent) toastr.info('LLM 未返回表格，已用 Horae 状态生成兜底表格');
                }
            }
            if (finalTable && Object.keys(finalTable).length) {
                await updateSnapshots(context, finalTable, storyDate, a.keepDays);
            } else {
                console.warn(`[${MODULE_NAME}] LLM 未返回有效 table 且无 Horae 兜底，快照未更新`);
                if (!s.silent) toastr.warning('LLM 未返回总结表格（表格区将为空）');
            }

            // 6. 逐个生图 + 卡片展示（替代 ST 原生 swipe，用折叠卡片）
            const N = Math.min(result.prompts.length, a.imageCount || 1);
            const prompts = result.prompts.slice(0, N);
            if (!message.extra) message.extra = {};
            message.extra.yh_card = {
                prompts: prompts.slice(),
                images: new Array(N).fill(null),
                status: new Array(N).fill('generating'),
                expanded: a.cardExpanded ?? true,
                layout: a.cardLayout || 'carousel',
                currentPage: 0,
            };
            renderYunhuiCard(message, msgEl);
            if (!s.silent) toastr.info(`自动生图 ${N} 张中...`);
            for (let i = 0; i < N; i++) {
                if (getCurrentChatId() !== currentChatId) break;
                const url = await generateImage(prompts[i]);
                const cd = message.extra.yh_card;
                if (url) { cd.images[i] = url; cd.status[i] = 'done'; }
                else { cd.status[i] = 'failed'; if (!s.silent) toastr.warning(`第 ${i+1} 张失败，可点卡片重抽`); }
                renderYunhuiCard(message, msgEl);
                await context.saveChat();
            }
            if (!s.silent) toastr.success(`自动生图完成`);
        } catch (e) {
            console.error(`[${MODULE_NAME}] 自动生图错误:`, e);
            if (!s.silent) toastr.error(`自动生图失败: ${e.message}`);
        } finally {
            GENERATING_FLAG.delete(mesId);
        }
    }, 50);
}

// 取最近 N 条消息文本（含角色名，去 HTML 标签）
function getRecentMessages(chat, n) {
    const start = Math.max(0, chat.length - n);
    const out = [];
    for (let i = start; i < chat.length; i++) {
        const m = chat[i];
        if (!m || !m.mes) continue;
        const name = m.is_user ? '用户' : (m.name || m.send_as || 'AI');
        const text = String(m.mes).replace(/<[^>]*>/g, '').slice(0, 500);
        if (i === chat.length - 1) {
            out.push('【最新消息·本次生图与总结的依据】\n' + name + ': ' + text);
        } else {
            out.push('（历史消息·仅作上下文参考）' + name + ': ' + text);
        }
    }
    return out.join('\n\n');
}

// 安全取 Horae state（过滤大对象，只留生图有用字段）
function safeHoraeState() {
    try {
        const st = window.Horae.getLatestState();
        return {
            story_date: st?.timestamp?.story_date || '',
            story_time: st?.timestamp?.story_time || '',
            location: st?.scene?.location || '',
            atmosphere: st?.scene?.atmosphere || '',
            characters_present: st?.scene?.characters_present || [],
            costumes: st?.costumes || {},
        };
    } catch (e) {
        console.warn(`[${MODULE_NAME}] Horae state 获取失败:`, e);
        return null;
    }
}

// 从 chatMetadata 取快照
function getSnapshots(context) {
    const md = context.chatMetadata;
    if (!md) return [];
    if (!Array.isArray(md.yh_snapshots)) md.yh_snapshots = [];
    return md.yh_snapshots;
}

// 按天更新快照（同日覆盖，跨天新增，FIFO 保 N 天，加时序标注）
async function updateSnapshots(context, table, storyDate, keepDays) {
    const md = context.chatMetadata;
    if (!md) return;
    if (!Array.isArray(md.yh_snapshots)) md.yh_snapshots = [];
    const snaps = md.yh_snapshots;
    const newSnap = { story_date: storyDate, table, ts: Date.now() };
    const idx = snaps.findIndex(s => s.story_date === storyDate);
    if (idx >= 0) snaps[idx] = newSnap;
    else {
        snaps.push(newSnap);
        while (snaps.length > (keepDays || 1)) snaps.shift();
    }
    const total = snaps.length;
    snaps.forEach((s, i) => {
        s.label = (i === total - 1) ? '【今天】' : (i === total - 2) ? '【昨天】' : '【较早】';
    });
    await context.saveMetadata();
}

// 从 Horae state 构造兜底表格（LLM 没返回 table 时用，至少保证穿着/场景/氛围/时间有数据）
function buildFallbackTable(h) {
    const table = {};
    const names = [];
    if (Array.isArray(h.characters_present)) h.characters_present.forEach(n => { if (n && !names.includes(n)) names.push(n); });
    Object.keys(h.costumes || {}).forEach(n => { if (!names.includes(n)) names.push(n); });
    names.forEach(n => {
        table[n] = {};
        if (h.costumes && h.costumes[n]) table[n]['穿着'] = h.costumes[n];
        if (h.location) table[n]['场景'] = h.location;
        if (h.atmosphere) table[n]['氛围'] = h.atmosphere;
        if (h.story_date) table[n]['时间'] = h.story_date;
    });
    return table;
}

// 构造总结+生图 system prompt（完整版：用户自定义优先，否则默认提示词工程）
// summaryPrompt 覆盖整个 system；promptRules 追加生图规则；两者都留空用默认
function buildAutoSystemPrompt(columns, snapshots, horaeState, a) {
    const colNames = columns.map(c => typeof c === 'string' ? c : c.name);
    const colsStr = colNames.join(' / ');
    const colsRules = columns.map(c => {
        const n = typeof c === 'string' ? c : c.name;
        const r = (typeof c === 'object' && c.rule) ? '：' + c.rule : '';
        return `- ${n}${r}`;
    }).join('\n');
    const snapsStr = snapshots.length
        ? snapshots.map(s => `${s.label || ''} ${s.story_date}: ${JSON.stringify(s.table)}`).join('\n')
        : '（无历史快照，本次为首条）';
    const horaeStr = horaeState ? JSON.stringify(horaeState, null, 2) : '（未启用 Horae 或数据源为自定义）';
    const userRules = (a.promptRules && a.promptRules.trim()) ? `\n\n用户自定义生图规则（必须遵守）：\n${a.promptRules}` : '';
    const N = a.imageCount || 1;
    // 用户自定义 system prompt：填了则覆盖默认，支持 {{宏}} 引用默认内容片段
    if (a.summaryPrompt && a.summaryPrompt.trim()) {
        const userTpl = a.summaryPrompt
            .split('{{COLUMNS}}').join(colsStr)
            .split('{{COLUMN_RULES}}').join(colsRules)
            .split('{{SNAPSHOTS}}').join(snapsStr)
            .split('{{HORAE_STATE}}').join(horaeStr)
            .split('{{PROMPT_RULES}}').join(userRules)
            .split('{{COUNT}}').join(String(N));
        return substituteParams(userTpl);
    }
    return `你是场景总结与生图提示词生成专家。

任务：根据当前对话剧情，输出${N}条独立的生图提示词 + 角色状态总结表格。

⚠️ 输出语言铁律：所有文字内容（表格每列的值、每条生图提示词）必须使用**中文**书写，严禁输出英文句子或英文单词（仅结构字段名例外）。生图提示词必须是通顺的中文自然语言段落。

## 参考资料优先级（冲突时按此顺序）
1. **当前对话文本**（最权威：提取角色外貌/妆容/发型/服饰/动作/场景细节）
2. Horae 状态（服装/地点/在场角色权威，但缺发型/妆容/长相，需从对话补齐）
3. 历史快照（仅作演变参考，一切以【今天】为准）

## 一、总结表格（按角色）
⚠️ table 必须包含当前场景**所有在场角色**的完整状态，绝不能返回空 table。
数据源为 Horae 时：把 Horae 的服装/地点/在场角色 + 从对话提取的发型/妆容/长相整合进 table。
数据源为自定义时：完全从对话文本总结。

列定义：${colsStr}
列提取规则：
${colsRules}
填写要求（供后续复用，务必具体）：
- 发型写发髻名称或披散方式（如"堕马髻""长发披肩"）；妆容写眉形/眼影/唇色（如"柳叶眉、正红唇"）
- 服饰必须写全：款式 + 颜色 + 材质 + 图案（如"白色暗纹齐胸襦裙，雪纺纱质，银线缠枝暗花"）
- 配饰写具体名称与材质（如"累丝金凤钗、珍珠耳坠"）
- 未变化的元素 → 与上一轮完全一致（不换词、不省略、不臆造）；只有剧情明确变化的元素才更新

更新规则：
- 跨天（第二天）→ 必须新开一条快照（默认换新一套服饰）
- 当天内脱下又穿回同一件 → 不更新
- 当天内明确更换（服饰/发型/妆容/场景）→ 更新当天条
- 未提及的列 → 保持上一轮值（不臆造、不置空）
- 冲突以最新对话为准

历史快照（带时序，一切以【今天】为准，旧的仅作演变参考）：
${snapsStr}

当前剧情状态（来自 Horae）：
${horaeStr}
⚠️ Horae 只有服装，缺发型/妆容/长相 → 从当前对话文本补齐。${userRules}

## 二、生图提示词（${N}条）
⚠️ 生图模型**逐张独立生成**，看不到其他图片、也不知道剧情。所以每条提示词必须**自包含完整信息**。

### 每条的 7 步结构（缺一不可，禁止省略任何一步）
①主体角色（长相/体型，与角色卡永久特征、快照一致）
②服饰与状态（款式/颜色/材质/图案/当前穿着状态，贴合汉服形制）
③姿势与动作
④表情与神态
⑤背景环境（场景/空间/周围事物）←必须写
⑥光线与色调（光源/明暗/氛围色）←必须写
⑦细节与氛围（构图/质感/空气感）←必须写
语言：一段连贯的中文自然语言画面白描，句与句自然衔接；禁止英文标签、禁止SD式关键词堆砌、禁止权重语法（()、[]、:1.2）。

⚠️ 结构顺序强制：每条提示词必须**以主体角色开头**（不是以环境/场景开头），按 ①→②→③→④→⑤→⑥→⑦ 依次层层展开。
   - 禁止把环境写在最前面
   - 禁止用"整体氛围温馨治愈""画面温馨"这类概括句代替 ⑦ 细节与氛围的具体描写
   - 禁止只写"人物+场景"两段就结束

⚠️ 篇幅要求：本模型没有 token/字数上限——每条必须**写足写满**（信息量参照下方示范），
   禁止一句话概括（如"少女在室内抬头看向镜头"这类属于不合格，必须展开成完整段落）。

### 元素三层规则（防止服饰/发型/妆容跑偏）
- **复用层（未变化时逐字沿用）**：发型、妆容、服饰（颜色/材质/图案）、配饰
  → 剧情没变化就必须与上表【今天】状态完全一致；禁止改写、禁止近义替换、禁止凭空新增
- **更新层（仅剧情明确变化时）**：同上四项 → 换衣/改妆发/增减配饰/披外衫/挽袖等，以最新对话为准更新
- **动态层（每张按剧情推演）**：姿势、动作、表情神态、场景、光线色调、氛围构图

### 姿势-服饰联动（同一套衣的现实状态）
同一套服饰会随姿势呈现不同穿着状态，如实描写：
- 站立 → 裙摆自然垂坠、衣料随身形垂落
- 坐下 → 裙摆铺展/堆叠在腿上、衣摆压出褶皱
- 蹲下 → 裙摆收拢、衣料堆叠在膝前
- 行走/回眸 → 衣袂飘动、裙摆随动作摆动
款式/颜色/图案不变，只有「穿着状态」随姿势重新描写（不是照抄上一张，也不是换一套衣服）。

### 描写范围 = 出图范围（铁律）
**生图提示词描写到哪里，图片范围就是哪里。** "半身照""全身照""特写"这类构图词无效，画面边界必须靠描写内容的边界来控制：
- 半身 → 只写腰线以上可见内容（面部/发型/肩颈/上半身服饰），不写裙摆/鞋/地板
- 全身 → 必须写到鞋子/地板/裙摆全貌
- 手部特写 → 只写手/指尖/袖口范围
- 脸部特写 → 只写眉眼/唇/妆容/发髻边缘

### 范围决策链（我的意图 + 距离 → 范围）
画面来自最新消息里"我"的视点与动作；距离决定看到多少（近大远小、空间透视）：
- 距离远（远远地看/几米外）→ 人眼相当于约35毫米标准镜头 → 全身范围（含鞋/地板）
- 距离中（正常对话距离）→ 半身范围
- 距离近（贴近/凑近/俯身）→ 特写范围（脸/手/局部）
意图示例：
- "我摸摸她的头" → 第一人称视角，头顶/手部近景范围
- "我看着手机屏幕" → 手机屏幕特写范围
- "我看着她"（未说全身）→ 半身范围

### 可见性铁律（只写视野内可见的内容）
- 只写"我"在这个位置、这个距离、这个视角下实际看得到的内容
- 对话里提到但我没看到的内容（例：提到她穿的什么颜色内裤，但画面里看不到）→ 禁止写入提示词
- 例外：世界观设定"我"有特殊能力（如透视）→ 可以写
- 被遮挡/未露出/背对镜头 → 不写

### 第一人称视角写法
- 第一人称视角用摄影术语，禁止出现"我/我的"：错误"我蹲下来，我的手"；正确"地面仰拍视角，衣袖从画面底部边缘隐约入镜"
- 第一人称视角时写"她看向镜头"，不写"她看着我"
- 每条提示词结尾必须加"保持第一人称视角"

### 画质与风格
- 风格：写实商业级画风、电影级打光
- 每组必须包含：环境背景 + 光线色调 + 画质词（三者缺一不可）
- 画质词：皮肤纹理、发丝细节、织物纹理细节、刺绣细节、缎面质感服饰布料、商业级画风、电影级打光、景深、对焦清晰
- 服饰质感：真丝缎面反光/织锦缎暗纹光泽/丝绒哑光/刺绣立体纹理
- 人物类型：汉服形制（齐胸襦裙/明制长袄/褙子/曲裾/诃子裙等）剧情下，人物统一描写为**汉服少女/汉服女性**（如"一位约二十岁的汉服少女"）；现代/其他服饰剧情按实际类型描写。禁止使用暗示未成年的词汇，禁止用"古典少女/古装少女"等泛泛词代替明确的服饰类型。

### 多张分配规则（剧情推进，禁止只换角度）
- N 张必须按剧情时间线推进：不同瞬间/动作阶段/情绪状态变化，禁止只换拍摄角度或景别凑数
- 例："摸摸头" → 第1张手伸近发顶的瞬间、第2张手掌落在发顶的瞬间、第3张轻抚时她神态变化的瞬间
- 若剧情极短只够一个瞬间 → 用动作的连贯阶段（前/中/后）或神态变化区分，仍禁止只换角度

### 一致性自检（输出前自查）
- ${N} 条的人物（发型/妆容/服饰/配饰）必须完全一致（除剧情明确变化的部分）
- 每条 7 步齐全、以主体角色开头依次展开；去掉环境/光线/画质词仍成立 → 说明写漏了，必须补全
- 每条结尾是否有画质词 + "保持第一人称视角"？没有就是不合格
- 信息密度是否达到示范水平？若一条只有一句话或缺少环境/光线/细节 → 不合格，重写
- 所有输出必须为**中文**（严禁英文句子/英文提示词）
- 画面范围与剧情视野一致（没看到的不要写）

### 生图提示词写法示范（仅示范结构与行文展开方式，内容禁止照抄）
第一人称视角，镜头位于主角肩部高度略微仰拍；画面中只显示一位约二十岁的汉服少女，瓜子脸、杏眼、气质温婉，乌黑长发挽成堕马髻、斜插一支累丝银钗；身穿白色暗纹齐胸襦裙，雪纺纱质裙摆自然垂坠，银线缠枝暗花随光微闪，腰间系同色丝绦、垂着小巧玉坠；她微微侧首看向镜头，指尖轻执一柄团扇；眼睫低垂，唇边含着一丝浅笑；背景是虚化的古典中式庭院，朱漆廊柱、青石地面，庭前桂树影影绰绰；午后暖光从侧前方洒落，侧逆金色轮廓光勾出肩颈与发丝边缘，暖调氛围通透柔和；皮肤纹理细腻可见，发丝与织物纹理清晰，刺绣针脚锐利，构图以人物为中心，浅景深，对焦锁定眼睛。商业级画风，电影级打光，超高清，对焦清晰。保持第一人称视角。

↑ 注意这段的行文展开顺序：**主体角色(长相/气质) → 发型妆容 → 服饰(款式/材质/图案/配饰) → 姿势动作 → 表情神态 → 背景环境 → 光线色调 → 细节与画质 → 结尾格式**，逐层展开、句句衔接。
   **这个信息密度是每条提示词的最低标准**——环境、光线、细节三项绝不能省。

## 输出格式（严格遵守结构，不要 Markdown 代码块，不要其他文本）
{
  "story_date": "剧情日期（中文）",
  "table": { "角色名（中文）": { "${colNames[0]}": "值（中文）", "${colNames[1]}": "值（中文）" } },
  "prompts": ["第一条生图提示词（中文自然语言段落）", "第二条生图提示词（中文自然语言段落）"]
}
⚠️ 结构里 story_date / table / prompts 是固定字段名（保持英文供程序解析），它们的**值必须全部是中文**。

⚠️ prompts 数组必须恰好 ${N} 条，不多不少。每条是独立的完整画面描述，不要合并成一条。`;
}

// 构造 user prompt（明确要求 N 条独立提示词）
function buildAutoUserPrompt(recentChat, a) {
    const N = a.imageCount || 1;
    return `最近对话（每条已标注属性）：

${recentChat}

标注说明：
- 【最新消息·本次生图与总结的依据】= 刚刚发生的那条，一切以它为准
- （历史消息·仅作上下文参考）= 之前的对话，帮助理解人物关系和剧情铺垫，不作为生图主体

任务：
1. 总结表格：基于【最新消息】更新角色状态（外貌/服饰/场景等），历史消息仅补充理解
2. 生图提示词（${N} 条）：描述【最新消息】中正在发生的画面（动作/场景/氛围），角色外观从表格取
3. 输出严格结构（表格必须非空，包含所有在场角色；**所有文字值必须用中文书写**）：
{"story_date": "剧情日期", "table": {"角色名": {"列名": "中文值"}}, "prompts": ["中文提示词1", "中文提示词2", ...]}
其中生图提示词恰好 ${N} 条独立完整画面描述，不要合并。不要任何额外文本。`;
}

// ============================================================
//  总结列管理 UI（加/删/改提取规则）+ 表格编辑（查看/编辑最新快照）
// ============================================================
function renderColumnsUI() {
    const a = getSettings().autoMode;
    const cols = a.customColumns || [];
    const $list = $('#yh_columns_list');
    if (!$list.length) return;
    $list.empty();
    if (!cols.length) {
        $list.append('<div class="margin0" style="opacity:.5;font-size:12px;">暂无列，请在下方添加</div>');
        return;
    }
    cols.forEach((c, i) => {
        const name = typeof c === 'string' ? c : c.name;
        const rule = (typeof c === 'object' && c.rule) ? c.rule : '';
        $list.append(`<div class="yh-col-item" data-idx="${i}">
            <span class="yh-col-name">${escapeText(name)}</span>
            <input class="text_pole yh-col-rule" type="text" placeholder="提取规则（可选）" value="${escapeAttr(rule)}" data-idx="${i}" title="编辑提取规则">
            <button class="yh-btn yh-col-del" data-idx="${i}" title="删除列"><i class="fa-solid fa-xmark"></i></button>
        </div>`);
    });
}

function addColumn() {
    const a = getSettings().autoMode;
    if (!Array.isArray(a.customColumns)) a.customColumns = [];
    const name = $('#yh_new_col_name').val().trim();
    if (!name) { toastr.warning('请输入列名'); return; }
    if (a.customColumns.some(c => (typeof c === 'string' ? c : c.name) === name)) { toastr.warning('列名已存在'); return; }
    a.customColumns.push({ name, rule: '' });
    saveSettingsDebounced();
    $('#yh_new_col_name').val('');
    renderColumnsUI();
}

function removeColumn(idx) {
    const a = getSettings().autoMode;
    if (!Array.isArray(a.customColumns) || idx < 0 || idx >= a.customColumns.length) return;
    a.customColumns.splice(idx, 1);
    saveSettingsDebounced();
    renderColumnsUI();
}

// 渲染当前总结表格编辑器（最新快照，按角色分行 × 列）
function renderTableEditor() {
    const context = getContext();
    const md = context.chatMetadata;
    const snaps = md && Array.isArray(md.yh_snapshots) ? md.yh_snapshots : [];
    const $ed = $('#yh_table_editor');
    if (!$ed.length) return;
    $ed.empty();
    if (!snaps.length) {
        $ed.append('<div class="margin0" style="opacity:.5;font-size:12px;">暂无快照（运行自动生图后产生）</div>');
        return;
    }
    const latest = snaps[snaps.length - 1];
    const table = latest.table || {};
    const a2 = getSettings().autoMode;
    const cols2 = (a2.customColumns?.length ? a2.customColumns : YH_DEFAULT_COLUMNS.map(n => ({ name: n })));
    const colNames2 = cols2.map(c => typeof c === 'string' ? c : c.name);
    const roleNames = Object.keys(table);
    if (!roleNames.length) {
        $ed.append(`<div class="margin0" style="opacity:.5;font-size:12px;">快照日期：${escapeText(latest.story_date || '?')}（无角色数据，LLM 未返回 table）</div>`);
        return;
    }
    if (!Object.keys(table).length) {
        $ed.append('<div class="margin0" style="opacity:.5;font-size:12px;">快照 table 为空对象</div>');
        return;
    }
    let h = `<div class="margin0" style="opacity:.6;font-size:12px;margin-bottom:4px;">日期：${escapeText(latest.story_date || '?')} · ${escapeText(latest.label || '')}</div>`;
    h += '<div class="yh-table-scroll"><table class="yh-table"><thead><tr><th>角色</th>';
    colNames2.forEach(n => h += `<th>${escapeText(n)}</th>`);
    h += '</tr></thead><tbody>';
    roleNames.forEach(r => {
        h += `<tr><td class="yh-table-role">${escapeText(r)}</td>`;
        colNames2.forEach(n => {
            const v = (table[r] && table[r][n]) || '';
            h += `<td><input class="text_pole yh-cell" type="text" data-role="${escapeAttr(r)}" data-col="${escapeAttr(n)}" value="${escapeAttr(v)}"></td>`;
        });
        h += '</tr>';
    });
    h += '</tbody></table></div>';
    $ed.append(h);
}

// 保存表格编辑（写回 chatMetadata 最新快照）
async function saveTableEditor() {
    const context = getContext();
    const md = context.chatMetadata;
    if (!md || !Array.isArray(md.yh_snapshots) || !md.yh_snapshots.length) { toastr.warning('暂无快照可保存'); return; }
    const latest = md.yh_snapshots[md.yh_snapshots.length - 1];
    if (!latest.table) latest.table = {};
    $('#yh_table_editor .yh-cell').each(function () {
        const role = $(this).attr('data-role');
        const col = $(this).attr('data-col');
        if (!latest.table[role]) latest.table[role] = {};
        latest.table[role][col] = $(this).val();
    });
    await context.saveMetadata();
    toastr.success('表格已保存到聊天元数据');
}


// 解析 LLM 输出 JSON（容错：去 \`\`\`json 包裹、提取首个 {...}）
function parseLLMJson(raw) {
    if (!raw || typeof raw !== 'string') return null;
    let text = raw.trim();
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) text = fence[1].trim();
    try { return JSON.parse(text); } catch (_) {}
    const m = text.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch (_) {} }
    return null;
}

// 调辅助 LLM（OpenAI 兼容接口）
async function callAuxLLM(a, sysPrompt, userPrompt) {
    if (!a.auxUrl) throw new Error('辅助模型地址未填');
    if (!a.auxModel) throw new Error('辅助模型未选');
    const url = a.auxUrl.replace(/\/+$/, '') + '/chat/completions';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000);
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(a.auxKey ? { 'Authorization': `Bearer ${a.auxKey}` } : {}),
            },
            body: JSON.stringify({
                model: a.auxModel,
                messages: [
                    { role: 'system', content: sysPrompt },
                    { role: 'user', content: userPrompt },
                ],
                temperature: 0.7,
            }),
            signal: controller.signal,
        });
        if (!res.ok) {
            const t = await res.text();
            throw new Error(`HTTP ${res.status}: ${t.slice(0, 200)}`);
        }
        const data = await res.json();
        return data?.choices?.[0]?.message?.content || '';
    } catch (e) {
        if (e.name === 'AbortError') throw new Error('辅助 LLM 超时（120s）');
        throw e;
    } finally {
        clearTimeout(timer);
    }
}

// ============================================================
//  调云绘生图 + 持久化
// ============================================================
async function generateImage(rawPrompt) {
    const s = getSettings();
    if (!s.baseUrl) { toastr.warning('请先填写云绘地址'); return null; }
    if (!s.model) { toastr.warning('请先选择生图模型'); return null; }

    // 画风词拼接
    let prompt = rawPrompt;
    const style = substituteParams(s.stylePrompt || '');
    if (style.trim()) {
        prompt = s.stylePrepend ? `${style}，${prompt}` : `${prompt}，${style}`;
    }

    const size = `${s.width}x${s.height}`;
    const body = {
        model: s.model,
        prompt,
        negative_prompt: substituteParams(s.negativePrompt || ''),
        size,
        n: 1,
    };

    const controller = new AbortController();
    const timeout = (s.timeout || 360) * 1000;
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
        const url = s.baseUrl.replace(/\/+$/, '') + '/images/generations';
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(s.apiKey ? { 'Authorization': `Bearer ${s.apiKey}` } : {}),
            },
            body: JSON.stringify(body),
            signal: controller.signal,
        });

        if (!res.ok) {
            const errText = await res.text();
            let errMsg = `HTTP ${res.status}`;
            try { const e = JSON.parse(errText); errMsg = e.error?.message || errMsg; } catch (_) {}
            throw new Error(errMsg);
        }

        const data = await res.json();
        const b64 = data?.data?.[0]?.b64_json;
        if (!b64) throw new Error('云绘未返回图片数据');

        // 持久化：base64 → 上传到 ST → 得到 path
        const context = getContext();
        const charName = context.groupId ? 'group' : (context.characters[context.characterId]?.name || '');
        const filename = charName ? `${charName}_${humanizedDateTime()}` : humanizedDateTime();
        const path = await saveBase64AsFile(b64, charName, filename, 'png');
        return path;
    } catch (e) {
        if (e.name === 'AbortError') toastr.error(`生图超时（${s.timeout}秒）`);
        else toastr.error(`生图失败: ${e.message}`);
        console.error(`[${MODULE_NAME}] generateImage:`, e);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

// ============================================================
//  插入模式 A：REPLACE（标签原位替换）
// ============================================================
function insertReplace(message, placeholder, imageUrl, prompt, mesId, context) {
    // 从占位符中取回原始标签
    let originalTag = '';
    const m = placeholder?.match(/data-yh-pending="([^"]*)"/);
    if (m) originalTag = unescapeAttr(m[1]);
    const escapedUrl = escapeAttr(imageUrl);
    const escapedPrompt = escapeAttr(prompt);
    const escapedOriginal = escapeAttr(originalTag);
    const _s = getSettings();
    const _w = parseInt(_s.width) || 512;
    const _h = parseInt(_s.height) || 512;
    const newTag = `<img src="${escapedUrl}" title="${escapedPrompt}" alt="${escapedPrompt}" data-yh-gen="${escapedOriginal}" style="${imgStyle(_w, _h)}">`;
    if (placeholder && message.mes.includes(placeholder)) {
        message.mes = message.mes.replace(placeholder, newTag);
    } else {
        message.mes = `${message.mes}\n${newTag}`;
    }
    updateMessageBlock(mesId, message);
    eventSource.emit(event_types.MESSAGE_UPDATED, mesId);
}

// ============================================================
//  插入模式 B：INLINE（消息底部附加图片）
// ============================================================
async function insertInline(message, imageUrl, prompt, msgEl, context) {
    if (!message.extra) message.extra = {};
    if (!Array.isArray(message.extra.image_swipes)) message.extra.image_swipes = [];
    if (message.extra.image && !message.extra.image_swipes.includes(message.extra.image)) {
        message.extra.image_swipes.push(message.extra.image);
    }
    message.extra.image_swipes.push(imageUrl);
    message.extra.image = imageUrl;
    message.extra.title = prompt;
    message.extra.inline_image = true;
    appendMediaToMessage(message, msgEl);
    await context.saveChat();
}
// ============================================================
//  模式2 末尾卡片（折叠卡片 + 三形态 + 每张状态 + 按钮）
//  数据：message.extra.yh_card = { prompts[], images[], status[], expanded, layout, currentPage }
//  status: 'generating' 生成中 / 'done' 完成 / 'failed' 失败
// ============================================================
function renderYunhuiCard(message, msgEl) {
    const card = message?.extra?.yh_card;
    if (!card || !msgEl?.length) return;
    const mesId = msgEl.attr('mesid');
    if (mesId == null) return;
    const cid = `yh-card-${mesId}`;
    $(`#${cid}`).remove();
    const $text = msgEl.find('.mes_text').first();
    if (!$text.length) return;
    $text.append(buildYunhuiCardHTML(card, mesId));
}

function buildYunhuiCardHTML(card, mesId) {
    const N = card.prompts.length;
    const done = card.status.filter(st => st === 'done').length;
    const failed = card.status.filter(st => st === 'failed').length;
    let statusText;
    if (N === 0) statusText = '—';
    else if (done === N) statusText = '✅完成';
    else if (failed > 0 && done === 0) statusText = `❌失败 ${failed}/${N}`;
    else if (failed > 0) statusText = `⚠️ ${done}/${N}`;
    else statusText = `⏳ ${done}/${N}`;
    const isSingle = N === 1;
    const layout = isSingle ? 'single' : (card.layout || 'carousel');
    const expanded = card.expanded !== false;
    let bodyHTML = '';
    if (layout === 'single') {
        bodyHTML = `<div class="yh-single">${buildCardPage(card, 0)}</div>`;
    } else if (layout === 'vertical') {
        bodyHTML = `<div class="yh-vlist">${card.prompts.map((_, i) => `<div class="yh-vitem">${buildCardPage(card, i)}</div>`).join('')}</div>`;
        bodyHTML += `<div class="yh-card-toolbar"><button class="yh-btn" data-yh-action="regen-all">🔄 重抽全部</button></div>`;
    } else if (layout === 'grid') {
        bodyHTML = `<div class="yh-grid">${card.prompts.map((_, i) => `<div class="yh-gitem">${buildCardPage(card, i)}</div>`).join('')}</div>`;
        bodyHTML += `<div class="yh-card-toolbar"><button class="yh-btn" data-yh-action="regen-all">🔄 重抽全部</button></div>`;
    } else { // carousel 左右翻页（默认）
        const cur = card.currentPage || 0;
        bodyHTML = `<div class="yh-carousel"><div class="yh-slider">${card.prompts.map((_, i) => `<div class="yh-slide${i===cur ? ' active' : ''}" data-idx="${i}">${buildCardPage(card, i, true)}</div>`).join('')}</div></div>`;
        // 圆点紧跟图片下方（指示第几张）
        if (N > 1) bodyHTML += `<div class="yh-dots">${card.prompts.map((_, i) => `<span class="yh-dot${i===cur ? ' active' : ''}" data-yh-action="dot" data-idx="${i}" title="第 ${i+1} 张"></span>`).join('')}</div>`;
        // 按钮排在最下方（作用于当前显示的这张；与圆点交换位置后离图片更远，不易误触）
        bodyHTML += `<div class="yh-card-toolbar yh-cur-btns">`
            + `<button class="yh-btn" data-yh-action="regen" title="用原提示词重抽本张">🔄</button>`
            + `<button class="yh-btn" data-yh-action="edit-prompt" title="查看/修改提示词后重抽">📝</button>`
            + `<button class="yh-btn" data-yh-action="zoom" title="看大图">🖼️</button>`
            + `<button class="yh-btn" data-yh-action="delete" title="删除本张">🗑️</button>`
            + `</div>`;
    }
    return `<div id="yh-card-${mesId}" class="yh-card${expanded ? '' : ' collapsed'}" data-mesid="${mesId}">
        <div class="yh-card-header" data-yh-action="toggle">
            <span class="yh-toggle">${expanded ? '▾' : '▸'}</span>
            <span class="yh-title">☁️ 云绘生图 · ${N}张 · ${statusText}</span>
        </div>
        <div class="yh-card-body">${bodyHTML}</div>
    </div>`;
}

function buildCardPage(card, i, noBtns) {
    const status = card.status[i] || 'generating';
    const img = card.images[i];
    const prompt = card.prompts[i] || '';
    const s = getSettings();
    const w = parseInt(s.width) || 512;
    const h = parseInt(s.height) || 512;
    if (status === 'done' && img) {
        return `<div class="yh-imgwrap"><img src="${escapeAttr(img)}" alt="${escapeAttr(prompt)}" data-idx="${i}" style="${cardImgStyle(w, h)}">`
            + (noBtns ? '' : `<div class="yh-imgbtns">`
            + `<button class="yh-btn" data-yh-action="regen" data-idx="${i}" title="用原提示词重抽本张">🔄</button>`
            + `<button class="yh-btn" data-yh-action="edit-prompt" data-idx="${i}" title="查看/修改提示词后重抽">📝</button>`
            + `<button class="yh-btn" data-yh-action="zoom" data-idx="${i}" title="看大图">🖼️</button>`
            + `<button class="yh-btn" data-yh-action="delete" data-idx="${i}" title="删除本张">🗑️</button>`
            + `</div>`) + `</div>`;
    } else if (status === 'failed') {
        return `<div class="yh-failed" style="${cardBoxStyle(w, h)}"><div>❌ 生成失败</div>`
            + `<div class="yh-imgbtns"><button class="yh-btn" data-yh-action="regen" data-idx="${i}">🔄 重抽</button>`
            + `<button class="yh-btn" data-yh-action="edit-prompt" data-idx="${i}">📝 改提示词</button></div></div>`;
    } else if (status === 'removed') {
        return `<div class="yh-removed" style="${cardBoxStyle(w, h)}"><div class="yh-removed-tip">🗑️ 已删除，提示词保留</div>`
            + `<div class="yh-imgbtns"><button class="yh-btn" data-yh-action="regen" data-idx="${i}">🔄 重新生成</button>`
            + `<button class="yh-btn" data-yh-action="edit-prompt" data-idx="${i}">📝 改提示词</button></div></div>`;
    }
    return `<div class="yh-loading" style="${cardBoxStyle(w, h)}">⏳ 生成中</div>`;
}

// 卡片事件委托（capture 阶段：ST 消息容器在冒泡阶段 stopPropagation，捕获先于冒泡拦不住）
if (!window.__yhCardBound) {
    window.__yhCardBound = true;
    // 卡片交互统一模型：按下只记录 → 抬起时判定（轻点才执行；滑动/拖动页面不执行）
    // 移动端与桌面端一致，且不会因"上一次滑动的残留标记 / 兼容 mousedown 事件"导致点击失灵
    let yhPendingTap = null;
    document.addEventListener('pointerdown', function (e) {
        const $el = $(e.target).closest('[data-yh-action]');
        if (!$el.length) return; // 点图片不再进看图（改用 🖼️ 按钮）
        const $card = $el.closest('[id^="yh-card-"]');
        if (!$card.length) return;
        yhPendingTap = { x: e.clientX, y: e.clientY, el: $el, card: $card, id: e.pointerId };
    }, true);
    document.addEventListener('pointercancel', function () { yhPendingTap = null; }, true);
    document.addEventListener('pointerup', function (e) {
        const p = yhPendingTap;
        yhPendingTap = null;
        if (!p || p.id !== e.pointerId) return;
        if (Math.abs(e.clientX - p.x) > 12 || Math.abs(e.clientY - p.y) > 12) return; // 滑动/拖动过 → 不执行
        runCardAction(p.el, p.card);
    }, true);

    function runCardAction($el, $card) {
        const mesId = $card.attr('data-mesid');
        const context = getContext();
        const message = context.chat && context.chat[mesId];
        if (!message?.extra?.yh_card) return;
        const cd = message.extra.yh_card;
        const action = $el.attr('data-yh-action');
        let idx = parseInt($el.attr('data-idx'));
        if (Number.isNaN(idx)) idx = -1; // 无 data-idx（如翻页按钮排）→ 用当前显示页
        const $mesEl = $(`.mes[mesid="${mesId}"]`);

        if (action === 'toggle') {
            if ($el.closest('.yh-btn').length) return; // 按钮不触发展开
            cd.expanded = !(cd.expanded !== false);
            renderYunhuiCard(message, $mesEl);
            context.saveChat();
        } else if (action === 'regen') {
            regenCardImage(message, mesId, idx >= 0 ? idx : (cd.currentPage || 0), context);
        } else if (action === 'regen-all') {
            regenAllCardImages(message, mesId, context);
        } else if (action === 'zoom') {
            const zi = idx >= 0 ? idx : (cd.currentPage || 0);
            const img = cd.images[zi];
            if (img) showYunhuiImageFullscreen(img);
        } else if (action === 'edit-prompt') {
            showPromptEditor(mesId, idx >= 0 ? idx : (cd.currentPage || 0));
        } else if (action === 'dot') {
            cd.currentPage = idx >= 0 ? idx : 0;
            renderYunhuiCard(message, $mesEl);
        } else if (action === 'delete') {
            const di = idx >= 0 ? idx : (cd.currentPage || 0);
            showConfirmDialog('删除这张图片？', '只删除图片，提示词保留（出现占位，可随时重新生成）。', function () {
                cd.images[di] = null;
                cd.status[di] = 'removed';       // 占位状态（样式类似"生成中"，但带"重新生成"按钮）
                renderYunhuiCard(message, $(`.mes[mesid="${mesId}"]`));
                context.saveChat();
            });
        } else if (action === 'prev') {
            cd.currentPage = Math.max(0, (cd.currentPage || 0) - 1);
            renderYunhuiCard(message, $mesEl);
        } else if (action === 'next') {
            cd.currentPage = Math.min(cd.prompts.length - 1, (cd.currentPage || 0) + 1);
            renderYunhuiCard(message, $mesEl);
        }
    }

    // 卡片手势：tap 图片=看大图 / 左右滑动=切换图片 / 上下滑动=页面正常滚动（不拦截，passive）
    let yhTouch = null;
    document.addEventListener('touchstart', function (e) {
        const $card = $(e.target).closest('[id^="yh-card-"]');
        if (!$card.length || e.touches.length !== 1) { yhTouch = null; return; }
        const t = e.touches[0];
        yhTouch = { x: t.clientX, y: t.clientY, card: $card, target: e.target, moved: false };
        yhTouchAt = Date.now();
    }, { capture: true, passive: true });
    // 手指移动过（累计 >5px）→ 标记为"滑动"，绝不是点击（防上下滚动/轻扫误判为点击看图）
    document.addEventListener('touchmove', function (e) {
        if (!yhTouch || e.touches.length !== 1) return;
        const t = e.touches[0];
        if (Math.abs(t.clientX - yhTouch.x) > 5 || Math.abs(t.clientY - yhTouch.y) > 5) yhTouch.moved = true;
    }, { capture: true, passive: true });
    document.addEventListener('touchend', function (e) {
        if (!yhTouch) return;
        const t = e.changedTouches && e.changedTouches[0];
        if (!t) { yhTouch = null; return; }
        const dx = t.clientX - yhTouch.x;
        const dy = t.clientY - yhTouch.y;
        const $card = yhTouch.card;
        const target = yhTouch.target;
        const wasMoved = yhTouch.moved; // 手指是否移动过（滚动/滑动）
        yhTouch = null;
        if (Math.abs(dx) > 12 || Math.abs(dy) > 12) yhSwipedAt = Date.now(); // 标记滑动，防 click 误触 toggle
        const mesId = $card.attr('data-mesid');
        const context = getContext();
        const message = context.chat && context.chat[mesId];
        const cd = message?.extra?.yh_card;
        if (!cd) return;
        // 左右滑动 → 切换图片（仅多张 + 左右翻页布局）
        if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.5) {
            if ((cd.layout || 'carousel') !== 'carousel' || cd.prompts.length <= 1) return;
            const dir = dx < 0 ? 1 : -1;
            const np = Math.min(cd.prompts.length - 1, Math.max(0, (cd.currentPage || 0) + dir));
            if (np === (cd.currentPage || 0)) return;
            cd.currentPage = np;
            renderYunhuiCard(message, $(`.mes[mesid="${mesId}"]`));
            return;
        }
        // 注意：点图片不再进看图（太容易误触）→ 统一用 🖼️ 按钮
    }, { capture: true, passive: true });
}

// 模式2 消息渲染时重建卡片（切聊天/重渲染/翻页回显）
eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, function (mesId) {
    const context = getContext();
    const message = context.chat && context.chat[mesId];
    if (!message?.extra?.yh_card) return;
    setTimeout(() => {
        renderYunhuiCard(message, $(`.mes[mesid="${mesId}"]`));
    }, 150);
});

// 扫描全部消息，从 extra.yh_card 重建卡片
// （刷新时消息渲染可能早于扩展加载 → CHARACTER_MESSAGE_RENDERED 被错过，必须主动扫描）
function rebuildAllYunhuiCards() {
    const context = getContext();
    if (!context.chat || !Array.isArray(context.chat)) return;
    let n = 0;
    context.chat.forEach((msg, idx) => {
        if (msg && msg.extra && msg.extra.yh_card) {
            const msgEl = $(`.mes[mesid="${idx}"]`);
            if (msgEl.length) { renderYunhuiCard(msg, msgEl); n++; }
        }
    });
    if (n) console.log(`[${MODULE_NAME}] 刷新重建 ${n} 个卡片`);
}

// 页面就绪后重建（等消息渲染完）；切聊天也重建
eventSource.on(event_types.APP_READY, function () {
    setTimeout(rebuildAllYunhuiCards, 600);
});
eventSource.on(event_types.CHAT_CHANGED, function () {
    setTimeout(rebuildAllYunhuiCards, 500);
});

// 重抽单张（原提示词）
async function regenCardImage(message, mesId, idx, context) {
    const cd = message?.extra?.yh_card;
    if (!cd || !cd.prompts[idx]) return;
    cd.status[idx] = 'generating';
    cd.images[idx] = null;
    renderYunhuiCard(message, $(`.mes[mesid="${mesId}"]`));
    const url = await generateImage(cd.prompts[idx]);
    // 只判断消息是否还在聊天里（不再用 currentChatId——它是"收到新消息"时才更新，
    // 用户主动重抽历史消息时会误判导致图片生成成功却不显示）
    const ctx = getContext();
    if (!(ctx.chat && ctx.chat[mesId] === message)) {
        console.warn(`[${MODULE_NAME}] 重抽完成但消息已不在聊天中，跳过更新`);
        return;
    }
    if (url) { cd.images[idx] = url; cd.status[idx] = 'done'; }
    else { cd.status[idx] = 'failed'; toastr.warning('重抽失败'); }
    renderYunhuiCard(message, $(`.mes[mesid="${mesId}"]`));
    await context.saveChat();
}

// 重抽全部（原提示词）
async function regenAllCardImages(message, mesId, context) {
    const cd = message.extra.yh_card;
    if (!cd) return;
    const N = cd.prompts.length;
    for (let i = 0; i < N; i++) { cd.status[i] = 'generating'; cd.images[i] = null; }
    renderYunhuiCard(message, $(`.mes[mesid="${mesId}"]`));
    for (let i = 0; i < N; i++) {
        const ctx2 = getContext();
        if (!(ctx2.chat && ctx2.chat[mesId] === message)) break; // 消息被删才中断
        const url = await generateImage(cd.prompts[i]);
        if (url) { cd.images[i] = url; cd.status[i] = 'done'; }
        else { cd.status[i] = 'failed'; }
        renderYunhuiCard(message, $(`.mes[mesid="${mesId}"]`));
        await context.saveChat();
    }
}

function showConfirmDialog(title, message, onOk) {
    // 延迟创建：防"点击穿透"（弹窗按钮与触发按钮坐标重叠时被同一次点击命中）
    setTimeout(function () {
    $('#yh-confirm').remove();
    const $d = $('<div id="yh-confirm" style="position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(0,0,0,.7);z-index:2147483647;display:flex;align-items:center;justify-content:center;">'
        + '<div style="width:86vw;max-width:420px;background:var(--SmartThemeBlurTintColor,#222);border:1px solid var(--SmartThemeBorderColor,#555);border-radius:12px;padding:16px;display:flex;flex-direction:column;gap:12px;">'
        + '<div style="font-size:15px;font-weight:600;">' + escapeText(title) + '</div>'
        + (message ? '<div style="font-size:13px;opacity:.8;line-height:1.5;">' + escapeText(message) + '</div>' : '')
        + '<div style="display:flex;gap:8px;justify-content:flex-end;">'
        + '<button class="menu_button yh-cf-cancel">取消</button>'
        + '<button class="menu_button yh-cf-ok">确定</button>'
        + '</div></div></div>').appendTo('body');
    yhDialogOpenedAt = Date.now(); // 防穿透：刚创建窗口内忽略命中弹窗按钮的残留点击
    $d.find('.yh-cf-cancel').on('click', function () { if (Date.now() - yhDialogOpenedAt < 200) return; $d.remove(); });
    $d.find('.yh-cf-ok').on('click', function () { if (Date.now() - yhDialogOpenedAt < 200) return; $d.remove(); if (typeof onOk === 'function') onOk(); });
    // 点背景关闭（用 click，不用 pointerdown，避免事件穿透）
    $d.on('click', function (ev) { if (ev.target !== this) return; if (Date.now() - yhDialogOpenedAt < 200) return; $d.remove(); });
    }, 60);
}

function showBigEditor(title, currentValue, onSave) {
    setTimeout(function () {
    $('#yh-big-editor').remove();
    const $ed = $('<div id="yh-big-editor" style="position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(0,0,0,.75);z-index:2147483647;display:flex;align-items:center;justify-content:center;">'
        + '<div style="width:92vw;max-width:720px;height:80vh;background:var(--SmartThemeBlurTintColor,#222);border:1px solid var(--SmartThemeBorderColor,#555);border-radius:12px;padding:12px;display:flex;flex-direction:column;gap:8px;">'
        + '<div style="font-size:14px;opacity:.9;flex-shrink:0;">' + escapeText(title) + '</div>'
        + '<textarea class="text_pole yh-be-text" style="flex:1;width:100%;font-size:13px;resize:none;min-height:200px;"></textarea>'
        + '<div style="display:flex;gap:8px;justify-content:flex-end;flex-shrink:0;">'
        + '<button class="menu_button yh-be-cancel">取消</button>'
        + '<button class="menu_button yh-be-ok">确定</button>'
        + '</div></div></div>').appendTo('body');
    $ed.find('.yh-be-text').val(currentValue || '');
    yhDialogOpenedAt = Date.now(); // 防穿透
    $ed.on('click', function (ev) { if (ev.target !== this) return; if (Date.now() - yhDialogOpenedAt < 200) return; $ed.remove(); });
    $ed.find('.yh-be-cancel').on('click', function () { if (Date.now() - yhDialogOpenedAt < 200) return; $ed.remove(); });
    $ed.find('.yh-be-ok').on('click', function () {
        if (Date.now() - yhDialogOpenedAt < 200) return;
        const val = $ed.find('.yh-be-text').val();
        $ed.remove();
        if (typeof onSave === 'function') onSave(val);
    });
    }, 60);
}

function showPromptEditor(mesId, idx) {
    setTimeout(function () {
    const context = getContext();
    const message = context.chat && context.chat[mesId];
    const cd = message?.extra?.yh_card;
    if (!cd) return;
    $('#yh-prompt-editor').remove();
    const $ed = $('<div id="yh-prompt-editor" style="position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(0,0,0,.75);z-index:2147483647;display:flex;align-items:center;justify-content:center;">'
        + '<div style="width:92vw;max-width:640px;background:var(--SmartThemeBlurTintColor,#222);border:1px solid var(--SmartThemeBorderColor,#555);border-radius:12px;padding:12px;display:flex;flex-direction:column;gap:8px;">'
        + '<div style="font-size:14px;opacity:.9;">' + String.fromCharCode(0xd83d, 0xdcdc) + ' 第 ' + (idx + 1) + ' 张 · 生图提示词</div>'
        + '<textarea class="text_pole yh-pe-text" rows="9" style="width:100%;font-size:12px;"></textarea>'
        + '<div style="display:flex;gap:8px;justify-content:flex-end;">'
        + '<button class="menu_button yh-pe-cancel">取消</button>'
        + '<button class="menu_button yh-pe-save">' + String.fromCharCode(0xd83d, 0xdcbe) + ' 只保存</button>'
        + '<button class="menu_button yh-pe-regen">' + String.fromCharCode(0xd83d, 0xdd04) + ' 保存并重抽</button>'
        + '</div></div></div>').appendTo('body');
    $ed.find('.yh-pe-text').val(cd.prompts[idx] || '');
    yhDialogOpenedAt = Date.now(); // 防穿透：卡片按钮是 pointerdown 触发，松手后的 click 会落到刚出现的弹窗上
    $ed.on('click', function (ev) { if (ev.target !== this) return; if (Date.now() - yhDialogOpenedAt < 200) return; $ed.remove(); });
    $ed.find('.yh-pe-cancel').on('click', function () { if (Date.now() - yhDialogOpenedAt < 200) return; $ed.remove(); });
    $ed.find('.yh-pe-save').on('click', async function () {
        if (Date.now() - yhDialogOpenedAt < 200) return;
        cd.prompts[idx] = $ed.find('.yh-pe-text').val();
        await context.saveChat();
        $ed.remove();
        toastr.success('提示词已保存');
    });
    $ed.find('.yh-pe-regen').on('click', async function () {
        if (Date.now() - yhDialogOpenedAt < 200) return;
        cd.prompts[idx] = $ed.find('.yh-pe-text').val();
        await context.saveChat();
        $ed.remove();
        regenCardImage(message, mesId, idx, context);
    });
    }, 60);
}

// 全屏看大图（双指捏合 + 滚轮缩放 + 拖拽平移）
function showYunhuiImageFullscreen(src) {
    let $m = $('#yh-zoomer');
    if (!$m.length) {
        $m = $('<div id="yh-zoomer" style="position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(0,0,0,.9);z-index:2147483647;display:none;align-items:center;justify-content:center;overflow:hidden;touch-action:none;">'
            + '<img style="max-width:92vw;max-height:90vh;border-radius:8px;object-fit:contain;transform-origin:center center;transition:transform .08s;">'
            + '<div style="position:absolute;bottom:12px;right:14px;color:#888;font-size:11px;opacity:.6;pointer-events:none;">双指缩放 · 双击复位 · 点空白关闭</div>'
            + '</div>').appendTo('body');
        let scale = 1, tx = 0, ty = 0, pinchDist = 0, dragStart = null, fsDown = null;
        const apply = function () { $m.find('img').css('transform', `translate(${tx}px,${ty}px) scale(${scale})`); };
        $m.on('wheel', function (ev) {
            ev.preventDefault();
            scale = Math.min(6, Math.max(0.5, scale * (ev.originalEvent.deltaY < 0 ? 1.15 : 0.87)));
            apply();
        });
        $m.on('dblclick', function () { scale = 1; tx = 0; ty = 0; apply(); });
        $m.on('pointerdown', function (ev) {
            fsDown = { x: ev.clientX, y: ev.clientY };
            if (scale > 1 && ev.target.tagName === 'IMG') {
                dragStart = { x: ev.clientX, y: ev.clientY, tx, ty };
            }
        });
        // 点空白关闭：必须在 click 阶段处理——若在 pointerdown 就 hide，
        // 后续 mouseup/click 会穿透到底层聊天输入框（手机上会弹出输入法）
        $m.on('click', function (ev) {
            if (ev.target !== this) return;
            if (Date.now() - fsOpenedAt < 400) return; // 刚打开（同一次点击残留）→ 忽略，防立即关闭
            const d = fsDown;
            fsDown = null;
            if (d && (Math.abs(ev.clientX - d.x) > 10 || Math.abs(ev.clientY - d.y) > 10)) return; // 拖动过 → 不关闭
            $m.hide();
        });
        $m.on('pointermove', function (ev) {
            if (dragStart) {
                tx = dragStart.tx + (ev.clientX - dragStart.x);
                ty = dragStart.ty + (ev.clientY - dragStart.y);
                apply();
            }
        });
        $m.on('pointerup', function () { dragStart = null; });
        $m.on('touchstart', function (ev) {
            if (ev.touches.length === 2) {
                const dx = ev.touches[0].clientX - ev.touches[1].clientX;
                const dy = ev.touches[0].clientY - ev.touches[1].clientY;
                pinchDist = Math.hypot(dx, dy);
            }
        });
        $m.on('touchmove', function (ev) {
            if (ev.touches.length === 2) {
                ev.preventDefault();
                const dx = ev.touches[0].clientX - ev.touches[1].clientX;
                const dy = ev.touches[0].clientY - ev.touches[1].clientY;
                const d = Math.hypot(dx, dy);
                if (pinchDist > 0) {
                    scale = Math.min(6, Math.max(0.5, scale * (d / pinchDist)));
                    apply();
                }
                pinchDist = d;
            }
        });
    }
    const $img = $m.find('img');
    $img.attr('src', src).css('transform', 'translate(0,0) scale(1)');
    fsOpenedAt = Date.now();
    $m.show().css('display', 'flex');
}



// ============================================================
//  占位符（生图期间显示"图片生成中"）
//  统一尺寸：占位符与最终图片共用同一 box 尺寸，避免布局跳动
// ============================================================
function placeholderBoxStyle(w, h) {
    return `display:flex;align-items:center;justify-content:center;background:var(--SmartThemeBlurTintColor,#2a2a2a);color:var(--SmartThemeBodyColor,#999);border-radius:10px;width:100%;max-width:${w}px;aspect-ratio:${w}/${h};font-size:14px;opacity:.75;`;
}
function imgStyle(w, h) {
    return `width:100%;max-width:${w}px;aspect-ratio:${w}/${h};border-radius:10px;object-fit:cover;display:block;`;
}
function cardBoxStyle(w, h) {
    return `display:flex;flex-direction:column;align-items:center;justify-content:center;background:var(--SmartThemeBlurTintColor,#2a2a2a);color:var(--SmartThemeBodyColor,#999);border-radius:10px;width:100%;aspect-ratio:${w}/${h};font-size:14px;opacity:.85;`;
}
function cardImgStyle(w, h) {
    return `width:100%;max-width:100%;aspect-ratio:${w}/${h};border-radius:10px;object-fit:cover;display:block;`;
}
function makePlaceholder(originalTag, width, height) {
    const escapedOriginal = escapeAttr(originalTag);
    const w = parseInt(width) || 512;
    const h = parseInt(height) || 512;
    return `<div class="yh-placeholder" data-yh-pending="${escapedOriginal}" style="${placeholderBoxStyle(w, h)}">⏳ 图片生成中...</div>`;
}

// ============================================================
//  流式隐藏生图标签（注册 ST 全局正则脚本，显示层生效）
//  ST 机制：渲染/流式显示都走 messageFormatting → getRegexedString，
//  正则 markdownOnly=true 时在显示层应用；promptOnly=false 不影响发给 AI 的文本
// ============================================================
const HIDE_TAGS_REGEX_ID = 'yunhui-image-gen-hide-tags';

function syncHideTagsRegex() {
    const s = getSettings();
    if (!Array.isArray(extension_settings.regex)) extension_settings.regex = [];
    const idx = extension_settings.regex.findIndex(x => x.id === HIDE_TAGS_REGEX_ID);
    if (s.hideTagsStream) {
        const script = {
            id: HIDE_TAGS_REGEX_ID,
            scriptName: '云绘生图-流式隐藏标签',
            findRegex: '/<local_img>[\\s\\S]*?<\\/local_img>/g',
            replaceString: `<div class="yh-placeholder" style="${placeholderBoxStyle(parseInt(s.width) || 512, parseInt(s.height) || 512)}">⏳ 图片生成中...</div>`,
            trimStrings: [],
            placement: [2],
            disabled: false,
            markdownOnly: true,
            promptOnly: false,
            runOnEdit: true,
            substituteRegex: 0,
            minDepth: null,
            maxDepth: null,
        };
        if (idx >= 0) extension_settings.regex[idx] = script;
        else extension_settings.regex.push(script);
    } else if (idx >= 0) {
        extension_settings.regex.splice(idx, 1);
    }
    saveSettingsDebounced();
}

// ============================================================
//  REPLACE 还原（把 <img data-yh-gen> / 占位符还原成原始标签文本）
// ============================================================
function restoreTags(content) {
    // 还原已完成图片
    content = content.replace(
        /<img\b[^>]*?\sdata-yh-gen="([^"]*)"[^>]*>/g,
        (_m, escaped) => unescapeAttr(escaped),
    );
    // 还原占位符（生图未完成时）
    content = content.replace(
        /<div\b[^>]*?\sdata-yh-pending="([^"]*)"[^>]*>[\s\S]*?<\/div>/g,
        (_m, escaped) => unescapeAttr(escaped),
    );
    return content;
}

// ============================================================
//  全屏子面板（打开 / 关闭 / tab 切换）
// ============================================================
function openPanel() {
    if (!$('#yh_panel_overlay').length) {
        // 容错：面板 DOM 丢失时重新加载
        toastr.warning('面板未加载，正在重建...');
        $.get(`${EXT_FOLDER}/panel.html`).then(html => {
            $('body').append(html);
            bindEvents();
            doOpenPanel();
        });
        return;
    }
    doOpenPanel();
}
function doOpenPanel() {
    yhPanelOpenedAt = Date.now(); // 记录打开时间（防同一次点击残留立即关闭面板）
    $('#yh_panel_overlay').css('display', 'flex');
    // 恢复上次选择的 tab（持久化）
    const savedTab = getSettings().activeTab || 'yh_tab_pane1';
    switchTab(savedTab);
    renderTableEditor(); // 打开面板时刷新表格（切聊天后数据更新）
    updateUI(); // 打开时同步最新设置
    if (!getSettings().silent) toastr.info('云绘生图面板已打开');
}
function closePanel() {
    $('#yh_panel_overlay').hide();
}
function switchTab(paneId) {
    const s = getSettings();
    s.activeTab = paneId; // 记住当前 tab（下次打开面板恢复）
    saveSettingsDebounced();
    $('.yh-panel-tab').removeClass('active');
    $(`.yh-panel-tab[data-yh-tab="${paneId}"]`).addClass('active');
    $('.yh-tab-pane').removeClass('active');
    $(`#${paneId}`).addClass('active');
}

// ============================================================
//  可拖拽悬浮按钮（右侧边垂直居中，位置记忆）
// ============================================================
function initFab() {
    if ($('#yh_fab').length) return;
    $('body').append(
        `<div id="yh_fab" title="云绘生图"><i class="fa-solid fa-cloud"></i></div>`,
    );
    const $fab = $('#yh_fab');
    // 根据设置决定显示/隐藏
    $fab.toggle(!!getSettings().fabVisible);

    // 恢复记忆位置（像素；null = 垂直居中）
    const savedTop = getSettings().fabTop;
    if (typeof savedTop === 'number' && !Number.isNaN(savedTop)) {
        $fab.css({ top: `${savedTop}px` });
    } else {
        $fab.css({ top: `${Math.round(window.innerHeight / 2 - 24)}px` });
    }

    let dragging = false;
    let moved = false;
    let startY = 0;
    let startTop = 0;
    let activePointerId = null;

    const onDown = (e) => {
        dragging = true;
        moved = false;
        startY = e.clientY;
        startTop = $fab[0].getBoundingClientRect().top;
        activePointerId = e.pointerId;
        $fab.addClass('dragging');
        try { $fab[0].setPointerCapture(e.pointerId); } catch (_) {}
        e.preventDefault();
    };
    const onMove = (e) => {
        if (!dragging) return;
        const dy = e.clientY - startY;
        if (Math.abs(dy) > 4) moved = true;
        let newTop = startTop + dy;
        newTop = Math.max(8, Math.min(window.innerHeight - 56, newTop));
        $fab.css({ top: `${newTop}px`, transform: 'none' });
    };
    const onUp = (e) => {
        if (!dragging) return;
        dragging = false;
        $fab.removeClass('dragging');
        try { if ($fab[0].hasPointerCapture?.(e.pointerId)) $fab[0].releasePointerCapture(e.pointerId); } catch (_) {}
        if (moved) {
            getSettings().fabTop = Math.round($fab[0].getBoundingClientRect().top);
            saveSettingsDebounced();
        } else {
            openPanel();
        }
    };

    // pointer 事件统一 mouse+touch，且不被 ST 父层 touch/mouse stopPropagation 拦截
    $fab[0].addEventListener('pointerdown', onDown);
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
}

// ============================================================
//  工具函数
// ============================================================
function escapeAttr(v) {
    return String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function unescapeAttr(v) {
    return String(v).replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
function escapeText(v) {
    return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ============================================================
//  初始化
// ============================================================
jQuery(async () => {
    // 添加扩展菜单按钮
    $('#extensionsMenu').append(
        `<div id="yunhui_image_gen_btn" class="list-group-item flex-container flexGap5">
            <div class="fa-solid fa-cloud"></div>
            <span>云绘生图</span>
        </div>`,
    );
    $('#yunhui_image_gen_btn').on('click', function () {
        openPanel(); // 直接打开全屏子面板
    });

    loadSettings();
    await createSettings();
    initFab(); // 可拖拽悬浮按钮

    // 扩展设置面板打开时刷新 UI
    $('#extensions-settings-button').on('click', function () {
        setTimeout(updateUI, 200);
    });

    console.log(`[${MODULE_NAME}] 云绘生图扩展已加载 v2.0.0`);
});