#include <pebble.h>

/* Quick Text: pick a contact, pick a message (or dictate one), and your iPhone sends it.
   The watch tells your phone, the phone tells Home Assistant, and Home Assistant sends a
   quiet notification that an iPhone Shortcuts automation turns into a text message. */

#if defined(PBL_PLATFORM_EMERY) || defined(PBL_PLATFORM_GABBRO)
  #define FONT_S   FONT_KEY_GOTHIC_18
  #define FONT_SB  FONT_KEY_GOTHIC_18_BOLD
  #define FONT_MB  FONT_KEY_GOTHIC_24_BOLD
  #define LH_S 20
  #define LH_M 28
  #define PAD 6
  #define MENU_HEADER_H 24
  #define ROW_H_SHORT 36
  #define ROW_H_TALL 52
#else
  #define FONT_S   FONT_KEY_GOTHIC_14
  #define FONT_SB  FONT_KEY_GOTHIC_14_BOLD
  #define FONT_MB  FONT_KEY_GOTHIC_18_BOLD
  #define LH_S 16
  #define LH_M 22
  #define PAD 4
  #define MENU_HEADER_H 19
  #define ROW_H_SHORT 27
  #define ROW_H_TALL 40
#endif

#define MAX_CONTACTS 8
#define MAX_MESSAGES 12
#define CONTACT_LEN 24
#define MESSAGE_LEN 48

// Persistent storage keys
#define P_THEME 1
#define P_CONTACT_COUNT 2
#define P_MESSAGE_COUNT 3
#define P_CONTACT_BASE 100
#define P_MESSAGE_BASE 200

// AppMessage keys. Watch -> phone: CMD, CONTACT, MSG, TEXT. Phone -> watch: the rest.
enum {
  KEY_CMD = 0, KEY_CONTACT = 1, KEY_MSG = 2, KEY_TEXT = 3,
  KEY_LIST_KIND = 4, KEY_LIST_INDEX = 5, KEY_LIST_COUNT = 6, KEY_LIST_TEXT = 7,
  KEY_STATUS = 8, KEY_STATUS_OK = 9, KEY_THEME = 10
};
enum { CMD_SEND = 1 };
enum { LIST_CONTACTS = 0, LIST_MESSAGES = 1 };

// Dark: green on black. Light: black on white.
static GColor s_col_bg, s_col_fg, s_col_dim, s_col_warn;
static bool s_light_theme = false;
#define C_BG     s_col_bg
#define C_BRIGHT s_col_fg
#define C_DIM    s_col_dim
#define C_WARN   s_col_warn

static char s_contacts[MAX_CONTACTS][CONTACT_LEN];
static char s_messages[MAX_MESSAGES][MESSAGE_LEN];
static int s_contact_count = 0;
static int s_message_count = 0;
static int s_selected_contact = -1;

static Window *s_contacts_window;
static MenuLayer *s_contacts_menu;
static Window *s_messages_window;
static MenuLayer *s_messages_menu;
static Window *s_status_window;
static Layer *s_status_layer;

static char s_status[64] = "";
static bool s_status_ok = false;
static AppTimer *s_close_timer = NULL;

#if defined(PBL_MICROPHONE)
  #define HAS_DICTATION 1
  static DictationSession *s_dictation;
  static char s_dictation_buf[120];
#else
  #define HAS_DICTATION 0
#endif

static void set_theme_colors(bool light) {
  s_light_theme = light;
  if (light) {
    s_col_bg = GColorWhite; s_col_fg = GColorBlack; s_col_dim = GColorDarkGray; s_col_warn = GColorRed;
  } else {
    s_col_bg = GColorBlack; s_col_fg = GColorGreen; s_col_dim = GColorIslamicGreen; s_col_warn = GColorYellow;
  }
}

/* On round watches the corners are cut off: draw inside the largest square in the circle. */
static GRect safe_bounds(GRect full) {
#if defined(PBL_ROUND)
  int side = (full.size.w * 707) / 1000;
  return GRect((full.size.w - side) / 2, (full.size.h - side) / 2, side, side);
#else
  return full;
#endif
}

static void draw_text(GContext *ctx, const char *text, GFont font, GRect rect, GTextAlignment align, GColor color) {
  graphics_context_set_text_color(ctx, color);
  graphics_draw_text(ctx, text, font, rect, GTextOverflowModeTrailingEllipsis, align, NULL);
}

/* ---------- Marquee: long text on the selected row slides like a car stereo ---------- */

#define MARQUEE_MS 80
#define MARQUEE_STEP 2
#define MARQUEE_PAUSE 12

static AppTimer *s_scroll_timer = NULL;
static int s_scroll_tick = 0;
static bool s_scroll_active = false;
static char s_marquee_key[160] = "";

static void scroll_timer_cb(void *data) {
  s_scroll_timer = NULL;
  if (!s_contacts_window && !s_messages_window) return;
  bool any = s_scroll_active;
  if (s_scroll_active) {
    s_scroll_tick++;
    s_scroll_active = false;               // drawing sets it again if still scrolling
    if (s_contacts_menu) layer_mark_dirty(menu_layer_get_layer(s_contacts_menu));
    if (s_messages_menu) layer_mark_dirty(menu_layer_get_layer(s_messages_menu));
  }
  s_scroll_timer = app_timer_register(any ? MARQUEE_MS : 300, scroll_timer_cb, NULL);
}

static void scroll_timer_start(void) {
  s_marquee_key[0] = '\0';
  s_scroll_tick = 0;
  if (!s_scroll_timer) s_scroll_timer = app_timer_register(MARQUEE_MS, scroll_timer_cb, NULL);
}

static void draw_marquee(GContext *ctx, const char *text, GFont font, GRect area, int cell_w,
                         GColor color, GColor bg, bool scroll) {
  GSize sz = graphics_text_layout_get_content_size(text, font, GRect(0, 0, 1000, area.size.h),
                                                   GTextOverflowModeWordWrap, GTextAlignmentLeft);
  int overflow = sz.w - area.size.w;
  if (!scroll || overflow <= 0) {
    draw_text(ctx, text, font, area, GTextAlignmentLeft, color);
    return;
  }
  s_scroll_active = true;
  int travel = (overflow + MARQUEE_STEP - 1) / MARQUEE_STEP;
  int cycle = MARQUEE_PAUSE + travel + MARQUEE_PAUSE;
  int t = s_scroll_tick % cycle;
  int off = 0;
  if (t >= MARQUEE_PAUSE + travel) off = overflow;
  else if (t >= MARQUEE_PAUSE) off = (t - MARQUEE_PAUSE) * MARQUEE_STEP;
  if (off > overflow) off = overflow;

  graphics_context_set_text_color(ctx, color);
  graphics_draw_text(ctx, text, font, GRect(area.origin.x - off, area.origin.y, sz.w + 8, area.size.h),
                     GTextOverflowModeWordWrap, GTextAlignmentLeft, NULL);
  graphics_context_set_fill_color(ctx, bg);
  graphics_fill_rect(ctx, GRect(0, area.origin.y, area.origin.x, area.size.h), 0, GCornerNone);
  graphics_fill_rect(ctx, GRect(area.origin.x + area.size.w, area.origin.y,
                                cell_w - area.origin.x - area.size.w, area.size.h), 0, GCornerNone);
}

/* ---------- Terminal-style menu drawing ---------- */

static void draw_menu_header(GContext *ctx, const Layer *cell_layer, const char *text) {
  GRect b = layer_get_bounds(cell_layer);
  graphics_context_set_fill_color(ctx, C_BG);
  graphics_fill_rect(ctx, b, 0, GCornerNone);
  draw_text(ctx, text, fonts_get_system_font(FONT_SB), GRect(PAD, 0, b.size.w - 2 * PAD, b.size.h - 2),
            GTextAlignmentLeft, C_DIM);
  graphics_context_set_stroke_color(ctx, C_DIM);
  for (int x = PAD; x < b.size.w - PAD; x += 4) {
    graphics_draw_line(ctx, GPoint(x, b.size.h - 2), GPoint(x + 1, b.size.h - 2));
  }
}

// Selected row is drawn inverted, like a terminal selection bar.
static void draw_menu_row(GContext *ctx, const Layer *cell_layer, const char *title, const char *subtitle) {
  GRect b = layer_get_bounds(cell_layer);
  bool hl = menu_cell_layer_is_highlighted(cell_layer);
  GColor fg = hl ? C_BG : C_BRIGHT;
  GColor dim = hl ? C_BG : C_DIM;
  GFont fs = fonts_get_system_font(FONT_S);
  GFont ft = fonts_get_system_font(FONT_MB);

  graphics_context_set_fill_color(ctx, hl ? C_BRIGHT : C_BG);
  graphics_fill_rect(ctx, b, 0, GCornerNone);

  char buf[96];
  snprintf(buf, sizeof(buf), "> %s", title);

  if (hl) {   // a newly selected row restarts its scroll from the beginning
    char key[160];
    snprintf(key, sizeof(key), "%s|%s", title, subtitle ? subtitle : "");
    if (strcmp(key, s_marquee_key) != 0) {
      snprintf(s_marquee_key, sizeof(s_marquee_key), "%s", key);
      s_scroll_tick = 0;
    }
  }

  GColor bg = hl ? C_BRIGHT : C_BG;
  int w = b.size.w;
  if (subtitle && subtitle[0]) {
    draw_marquee(ctx, buf, ft, GRect(PAD, 1, w - 2 * PAD, LH_M), w, fg, bg, hl);
    draw_marquee(ctx, subtitle, fs, GRect(PAD, 1 + LH_M, w - 2 * PAD, LH_S), w, dim, bg, hl);
  } else {
    draw_marquee(ctx, buf, ft, GRect(PAD, (b.size.h - LH_M) / 2 - 2, w - 2 * PAD, LH_M), w, fg, bg, hl);
  }
}

static void style_menu_layer(MenuLayer *layer) {
  menu_layer_set_normal_colors(layer, C_BG, C_BRIGHT);
  menu_layer_set_highlight_colors(layer, C_BRIGHT, C_BG);
}

// Up on the first row jumps to the last; Down on the last row jumps to the first
static void menu_wrap_move(MenuLayer *layer, bool up, uint16_t rows) {
  MenuIndex idx = menu_layer_get_selected_index(layer);
  if (up && idx.row == 0) {
    menu_layer_set_selected_index(layer, MenuIndex(0, rows - 1), MenuRowAlignCenter, true);
  } else if (!up && idx.row >= rows - 1) {
    menu_layer_set_selected_index(layer, MenuIndex(0, 0), MenuRowAlignCenter, true);
  } else {
    menu_layer_set_selected_next(layer, up, MenuRowAlignCenter, true);
  }
}

/* ---------- Sending ---------- */

static void show_status_window(void);

static void set_status(const char *text, bool ok) {
  snprintf(s_status, sizeof(s_status), "%s", text);
  s_status_ok = ok;
  if (s_status_layer) layer_mark_dirty(s_status_layer);
}

// text == NULL sends the canned message at msg_index, otherwise the dictated text
static void send_to_phone(int msg_index, const char *text) {
  DictionaryIterator *iter;
  if (app_message_outbox_begin(&iter) != APP_MSG_OK || !iter) {
    set_status("watch busy, try again", false);
    show_status_window();
    return;
  }
  dict_write_uint8(iter, KEY_CMD, CMD_SEND);
  dict_write_int8(iter, KEY_CONTACT, (int8_t)s_selected_contact);
  if (text) dict_write_cstring(iter, KEY_TEXT, text);
  else dict_write_int8(iter, KEY_MSG, (int8_t)msg_index);
  app_message_outbox_send();

  set_status("sending...", true);
  show_status_window();
}

#if HAS_DICTATION
static void dictation_cb(DictationSession *session, DictationSessionStatus status, char *transcription, void *context) {
  if (status == DictationSessionStatusSuccess) {
    send_to_phone(-1, transcription);
  }
}
#endif

/* ---------- Status window ---------- */

static void status_update_proc(Layer *layer, GContext *ctx) {
  GRect b = layer_get_bounds(layer);
  int w = b.size.w;
  GFont fsb = fonts_get_system_font(FONT_SB);
  GFont fmb = fonts_get_system_font(FONT_MB);
  GFont fs = fonts_get_system_font(FONT_S);

  draw_text(ctx, "# quick_text_", fsb, GRect(PAD, 0, w - 2 * PAD, LH_S), GTextAlignmentLeft, C_BRIGHT);
  graphics_context_set_stroke_color(ctx, C_DIM);
  for (int x = PAD; x < w - PAD; x += 4) {
    graphics_draw_line(ctx, GPoint(x, LH_S + 3), GPoint(x + 1, LH_S + 3));
  }

  char line[80];
  snprintf(line, sizeof(line), "> %s", s_status);
  draw_text(ctx, line, fmb, GRect(PAD, LH_S + 12, w - 2 * PAD, b.size.h - LH_S - 12 - LH_S),
            GTextAlignmentLeft, s_status_ok ? C_BRIGHT : C_WARN);
  if (!s_status_ok) {
    draw_text(ctx, "BACK  close", fs, GRect(PAD, b.size.h - LH_S - 2, w - 2 * PAD, LH_S), GTextAlignmentLeft, C_DIM);
  }
}

static void close_timer_cb(void *data) {
  s_close_timer = NULL;
  if (s_status_window) window_stack_remove(s_status_window, false);
  if (s_messages_window) window_stack_remove(s_messages_window, true);   // back to the contact list
}

static void status_window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  s_status_layer = layer_create(safe_bounds(layer_get_bounds(root)));
  layer_set_update_proc(s_status_layer, status_update_proc);
  layer_add_child(root, s_status_layer);
}

static void status_window_unload(Window *window) {
  if (s_close_timer) { app_timer_cancel(s_close_timer); s_close_timer = NULL; }
  layer_destroy(s_status_layer);
  s_status_layer = NULL;
  window_destroy(window);
  s_status_window = NULL;
}

static void show_status_window(void) {
  if (s_status_window) { layer_mark_dirty(s_status_layer); return; }
  s_status_window = window_create();
  window_set_background_color(s_status_window, C_BG);
  window_set_window_handlers(s_status_window, (WindowHandlers) {
    .load = status_window_load, .unload = status_window_unload
  });
  window_stack_push(s_status_window, true);
}

/* ---------- Messages menu (second level) ---------- */

static int dictate_rows(void) { return HAS_DICTATION ? 1 : 0; }

static uint16_t messages_row_count(void) {
  int n = dictate_rows() + s_message_count;
  return n == 0 ? 1 : n;
}

static uint16_t messages_get_num_rows(MenuLayer *l, uint16_t section, void *ctx) { return messages_row_count(); }
static int16_t messages_header_height(MenuLayer *l, uint16_t section, void *ctx) { return MENU_HEADER_H; }

static void messages_draw_header(GContext *ctx, const Layer *cell_layer, uint16_t section, void *context) {
  char buf[48];
  snprintf(buf, sizeof(buf), "$ to %s_",
           (s_selected_contact >= 0 && s_selected_contact < s_contact_count) ? s_contacts[s_selected_contact] : "?");
  draw_menu_header(ctx, cell_layer, buf);
}

static int16_t messages_cell_height(MenuLayer *l, MenuIndex *idx, void *ctx) {
  return (dictate_rows() + s_message_count == 0) ? ROW_H_TALL : ROW_H_SHORT;
}

static void messages_draw_row(GContext *ctx, const Layer *cell_layer, MenuIndex *idx, void *context) {
  if (dictate_rows() + s_message_count == 0) {
    draw_menu_row(ctx, cell_layer, "no messages", "add them in the phone settings");
    return;
  }
  if (HAS_DICTATION && idx->row == 0) {
    draw_menu_row(ctx, cell_layer, "dictate...", NULL);
    return;
  }
  draw_menu_row(ctx, cell_layer, s_messages[idx->row - dictate_rows()], NULL);
}

static void messages_select(MenuLayer *layer, MenuIndex *idx) {
  if (dictate_rows() + s_message_count == 0) return;
  vibes_short_pulse();
#if HAS_DICTATION
  if (idx->row == 0) {
    dictation_session_start(s_dictation);
    return;
  }
#endif
  send_to_phone(idx->row - dictate_rows(), NULL);
}

static void messages_up(ClickRecognizerRef r, void *ctx) { menu_wrap_move((MenuLayer *)ctx, true, messages_row_count()); }
static void messages_down(ClickRecognizerRef r, void *ctx) { menu_wrap_move((MenuLayer *)ctx, false, messages_row_count()); }
static void messages_select_click(ClickRecognizerRef r, void *ctx) {
  MenuLayer *layer = (MenuLayer *)ctx;
  MenuIndex idx = menu_layer_get_selected_index(layer);
  messages_select(layer, &idx);
}

static void messages_click_config(void *context) {
  window_single_repeating_click_subscribe(BUTTON_ID_UP, 120, messages_up);
  window_single_repeating_click_subscribe(BUTTON_ID_DOWN, 120, messages_down);
  window_single_click_subscribe(BUTTON_ID_SELECT, messages_select_click);
}

static void messages_window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  s_messages_menu = menu_layer_create(safe_bounds(layer_get_bounds(root)));
  style_menu_layer(s_messages_menu);
  menu_layer_set_callbacks(s_messages_menu, NULL, (MenuLayerCallbacks){
    .get_num_rows = messages_get_num_rows,
    .get_header_height = messages_header_height,
    .draw_header = messages_draw_header,
    .get_cell_height = messages_cell_height,
    .draw_row = messages_draw_row,
  });
  window_set_click_config_provider_with_context(window, messages_click_config, s_messages_menu);
  layer_add_child(root, menu_layer_get_layer(s_messages_menu));
}

static void messages_window_unload(Window *window) {
  menu_layer_destroy(s_messages_menu);
  s_messages_menu = NULL;
  window_destroy(window);
  s_messages_window = NULL;
}

static void open_messages(void) {
  if (s_messages_window) return;
  s_messages_window = window_create();
  window_set_background_color(s_messages_window, C_BG);
  window_set_window_handlers(s_messages_window, (WindowHandlers) {
    .load = messages_window_load, .unload = messages_window_unload
  });
  window_stack_push(s_messages_window, true);
  scroll_timer_start();
}

/* ---------- Contacts menu (first level) ---------- */

static uint16_t contacts_row_count(void) { return s_contact_count == 0 ? 1 : s_contact_count; }
static uint16_t contacts_get_num_rows(MenuLayer *l, uint16_t section, void *ctx) { return contacts_row_count(); }
static int16_t contacts_header_height(MenuLayer *l, uint16_t section, void *ctx) { return MENU_HEADER_H; }

static void contacts_draw_header(GContext *ctx, const Layer *cell_layer, uint16_t section, void *context) {
  draw_menu_header(ctx, cell_layer, "$ send_to_");
}

static int16_t contacts_cell_height(MenuLayer *l, MenuIndex *idx, void *ctx) {
  return s_contact_count == 0 ? ROW_H_TALL : ROW_H_SHORT;
}

static void contacts_draw_row(GContext *ctx, const Layer *cell_layer, MenuIndex *idx, void *context) {
  if (s_contact_count == 0) {
    draw_menu_row(ctx, cell_layer, "no contacts", "add them in the phone settings");
    return;
  }
  draw_menu_row(ctx, cell_layer, s_contacts[idx->row], NULL);
}

static void contacts_select(MenuLayer *layer, MenuIndex *idx) {
  if (s_contact_count == 0) return;
  s_selected_contact = idx->row;
  open_messages();
}

static void contacts_up(ClickRecognizerRef r, void *ctx) { menu_wrap_move((MenuLayer *)ctx, true, contacts_row_count()); }
static void contacts_down(ClickRecognizerRef r, void *ctx) { menu_wrap_move((MenuLayer *)ctx, false, contacts_row_count()); }
static void contacts_select_click(ClickRecognizerRef r, void *ctx) {
  MenuLayer *layer = (MenuLayer *)ctx;
  MenuIndex idx = menu_layer_get_selected_index(layer);
  contacts_select(layer, &idx);
}

static void contacts_click_config(void *context) {
  window_single_repeating_click_subscribe(BUTTON_ID_UP, 120, contacts_up);
  window_single_repeating_click_subscribe(BUTTON_ID_DOWN, 120, contacts_down);
  window_single_click_subscribe(BUTTON_ID_SELECT, contacts_select_click);
  // Back is left alone, so it exits right away
}

static void contacts_window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  s_contacts_menu = menu_layer_create(safe_bounds(layer_get_bounds(root)));
  style_menu_layer(s_contacts_menu);
  menu_layer_set_callbacks(s_contacts_menu, NULL, (MenuLayerCallbacks){
    .get_num_rows = contacts_get_num_rows,
    .get_header_height = contacts_header_height,
    .draw_header = contacts_draw_header,
    .get_cell_height = contacts_cell_height,
    .draw_row = contacts_draw_row,
  });
  window_set_click_config_provider_with_context(window, contacts_click_config, s_contacts_menu);
  layer_add_child(root, menu_layer_get_layer(s_contacts_menu));
}

static void contacts_window_unload(Window *window) {
  menu_layer_destroy(s_contacts_menu);
  s_contacts_menu = NULL;
}

/* ---------- Settings, storage and messages from the phone ---------- */

static void apply_theme(bool light, bool save) {
  set_theme_colors(light);
  if (save) persist_write_bool(P_THEME, light);
  Window *wins[3] = { s_contacts_window, s_messages_window, s_status_window };
  for (int i = 0; i < 3; i++) if (wins[i]) window_set_background_color(wins[i], C_BG);
  if (s_contacts_menu) { style_menu_layer(s_contacts_menu); menu_layer_reload_data(s_contacts_menu); }
  if (s_messages_menu) { style_menu_layer(s_messages_menu); menu_layer_reload_data(s_messages_menu); }
  if (s_status_layer) layer_mark_dirty(s_status_layer);
}

static void load_lists(void) {
  s_contact_count = persist_exists(P_CONTACT_COUNT) ? persist_read_int(P_CONTACT_COUNT) : 0;
  s_message_count = persist_exists(P_MESSAGE_COUNT) ? persist_read_int(P_MESSAGE_COUNT) : 0;
  if (s_contact_count > MAX_CONTACTS) s_contact_count = MAX_CONTACTS;
  if (s_message_count > MAX_MESSAGES) s_message_count = MAX_MESSAGES;
  for (int i = 0; i < s_contact_count; i++) {
    s_contacts[i][0] = '\0';
    persist_read_string(P_CONTACT_BASE + i, s_contacts[i], CONTACT_LEN);
  }
  for (int i = 0; i < s_message_count; i++) {
    s_messages[i][0] = '\0';
    persist_read_string(P_MESSAGE_BASE + i, s_messages[i], MESSAGE_LEN);
  }
}

static void in_received_handler(DictionaryIterator *iter, void *context) {
  Tuple *theme = dict_find(iter, KEY_THEME);
  if (theme) {
    bool light = theme->value->int32 != 0;
    if (light != s_light_theme) apply_theme(light, true);
  }

  // A contact or message list: a count message first, then one message per item
  Tuple *kind = dict_find(iter, KEY_LIST_KIND);
  if (kind) {
    bool contacts = kind->value->int32 == LIST_CONTACTS;
    Tuple *count = dict_find(iter, KEY_LIST_COUNT);
    Tuple *index = dict_find(iter, KEY_LIST_INDEX);
    Tuple *text = dict_find(iter, KEY_LIST_TEXT);
    if (count) {
      int n = count->value->int32;
      if (n < 0) n = 0;
      if (contacts) {
        s_contact_count = n > MAX_CONTACTS ? MAX_CONTACTS : n;
        persist_write_int(P_CONTACT_COUNT, s_contact_count);
      } else {
        s_message_count = n > MAX_MESSAGES ? MAX_MESSAGES : n;
        persist_write_int(P_MESSAGE_COUNT, s_message_count);
      }
    }
    if (index && text) {
      int i = index->value->int32;
      if (contacts && i >= 0 && i < MAX_CONTACTS) {
        snprintf(s_contacts[i], CONTACT_LEN, "%s", text->value->cstring);
        persist_write_string(P_CONTACT_BASE + i, s_contacts[i]);
      } else if (!contacts && i >= 0 && i < MAX_MESSAGES) {
        snprintf(s_messages[i], MESSAGE_LEN, "%s", text->value->cstring);
        persist_write_string(P_MESSAGE_BASE + i, s_messages[i]);
      }
    }
    if (s_contacts_menu) menu_layer_reload_data(s_contacts_menu);
    if (s_messages_menu) menu_layer_reload_data(s_messages_menu);
  }

  // The phone's answer to a send
  Tuple *status = dict_find(iter, KEY_STATUS);
  if (status) {
    Tuple *ok = dict_find(iter, KEY_STATUS_OK);
    bool good = ok && ok->value->int32 != 0;
    set_status(status->value->cstring, good);
    if (s_status_window) {
      if (good) {
        vibes_double_pulse();
        if (s_close_timer) app_timer_cancel(s_close_timer);
        s_close_timer = app_timer_register(1500, close_timer_cb, NULL);   // then back to the contacts
      } else {
        vibes_long_pulse();
      }
    }
  }
}

/* ---------- App ---------- */

static void init(void) {
  set_theme_colors(persist_exists(P_THEME) ? persist_read_bool(P_THEME) : false);
  load_lists();

  s_contacts_window = window_create();
  window_set_background_color(s_contacts_window, C_BG);
  window_set_window_handlers(s_contacts_window, (WindowHandlers) {
    .load = contacts_window_load, .unload = contacts_window_unload
  });
  window_stack_push(s_contacts_window, true);
  scroll_timer_start();

  app_message_register_inbox_received(in_received_handler);
  app_message_open(256, 160);

#if HAS_DICTATION
  s_dictation = dictation_session_create(sizeof(s_dictation_buf), dictation_cb, NULL);
#endif
}

static void deinit(void) {
#if HAS_DICTATION
  dictation_session_destroy(s_dictation);
#endif
  if (s_scroll_timer) app_timer_cancel(s_scroll_timer);
  window_destroy(s_contacts_window);
}

int main(void) {
  init();
  app_event_loop();
  deinit();
}
