// mjpeg streamer on its own wifi and power. the flash lamp is the boot indicator:
// slow blink booting, fast blink on error, steady dim once connected — setup() only.

#include "esp_camera.h"
#include <WiFi.h>
#include <ESPmDNS.h>
#include "esp_http_server.h"
#include "arduino_secrets.h"

// The cam over its own USB cable: no wifi, no router, no hotspot. The board hands
// a jpeg down the serial port when the PC asks for one and server/camserial.js
// re-serves it as the same /stream, /capture and /control the wifi cam answers on.
// 921600 because a 23KB svga frame is TWO SECONDS at 115200 -- if an adapter
// garbles it, drop this and CAM_BAUD in camserial.js together, they must match.
#define CAM_BAUD 921600

#define LED_PIN 4
#define LED_BRIGHT 32
#define LED_OFF 0

enum LedMode { LED_BOOT, LED_CONNECTED, LED_ERROR };
LedMode ledMode = LED_BOOT;
unsigned long ledPrevMs = 0;
bool ledToggle = false;

static void ledUpdate() {
  unsigned long now = millis();
  unsigned long interval;
  switch (ledMode) {
    case LED_BOOT:      interval = 500; break;
    case LED_ERROR:     interval = 100; break;
    case LED_CONNECTED: ledcWrite(LED_PIN, LED_BRIGHT); return;
  }
  if (now - ledPrevMs >= interval) {
    ledPrevMs = now;
    ledToggle = !ledToggle;
    ledcWrite(LED_PIN, ledToggle ? LED_BRIGHT : LED_OFF);
  }
}

// ---- identity ----
// THE SAME SKETCH GOES ON BOTH BOARDS. The eFuse MAC is burned at the factory and
// is unique per chip, so each board looks itself up here rather than carrying a
// hand-set id that gets flashed to the wrong one -- two boards answering the same
// mDNS name is a collision the server's 60s resolve cache turns into "cam 2
// silently serves cam 1's frames", which reads as a dead second cam.
//
// Adding a board: flash it, watch serial. An unknown chip prints
//   chip a1b2c3d4e5f6 -> UNCLAIMED
// and comes up on DHCP as blackout-cam-e5f6. That id is the eFuse MAC read as one
// integer -- its bytes run the other way round from the MAC the hotspot's client
// list shows, so read it off serial and don't try to match the two by eye.
// Paste that id into the slot you want
// and reflash. After that the boards are self-sorting forever -- upload to
// whichever one is plugged in, it knows which camera it is.
static const uint64_t CAM_CHIPS[] = {
  0x98BB31FE8CE0ULL,  // slot 1 -- front cam: Sage's stills and the headlamp
  0x283830FE8CE0ULL,  // slot 2 -- arm/gripper cam; Sage sees it only via the "armcam" tool
};
static const int CAM_SLOTS = sizeof(CAM_CHIPS) / sizeof(CAM_CHIPS[0]);

int camSlot = 0;          // 1..CAM_SLOTS, or 0 for a chip that isn't in the table
char camName[24] = "blackout-cam";

static void camIdentify() {
  uint64_t chip = ESP.getEfuseMac();
  for (int i = 0; i < CAM_SLOTS; i++)
    if (CAM_CHIPS[i] && CAM_CHIPS[i] == chip) { camSlot = i + 1; break; }

  if (camSlot == 1)      snprintf(camName, sizeof camName, "blackout-cam");
  else if (camSlot > 1)  snprintf(camName, sizeof camName, "blackout-cam%d", camSlot);
  // an unclaimed board still has to come up and be reachable, or you can't read
  // its id off the network to claim it
  else snprintf(camName, sizeof camName, "blackout-cam-%04x", (unsigned)(chip & 0xFFFF));

  Serial.printf("chip %012llx -> %s (%s)\n", chip,
                camSlot ? camName : "UNCLAIMED", camSlot ? "static IP" : "DHCP");
}

// ---- wifi ----
// Pick the network at flash time. Each row carries its own subnet, because a
// static IP only means anything on the network it was minted for -- flashing
// HOME while CAM_GW still said 172.20.10.1 used to hand the cam an address its
// router would never route.
// ip[3] is the slot base: slot 1 -> .10, slot 2 -> .11, and .1 of the same
// subnet is the gateway. Keep in step with CAM_DEFAULTS in the dashboard's
// app.js -- npm run test:detect fails if the two drift.
// A row with ip {0,0,0,0} is DHCP + mDNS only.
// NET_NONE is the cable-only build: the radio is never brought up at all, so
// there is no 15s join in setup(), no 10s retry cycling the radio in loop(), and
// no http server -- the board answers nothing but the serial port. Pick it when
// the cam is tethered to the PC; anything that drives away from the cable needs
// one of the rows above back.
// #define, NEVER an enum: the preprocessor cannot see an enum, so
// `#if CAM_NETWORK != NET_NONE` reads both names as 0, compares 0 != 0 and
// compiles the radio out of EVERY build -- which shows up as a 522KB binary
// where the wifi one is 1082KB, and as a cam that never joins anything.
#define NET_HOME    0
#define NET_SCHOOL  1
#define NET_HOTSPOT 2
#define NET_ROUTER  3
#define NET_NONE    4
#define CAM_NETWORK NET_NONE

static const struct {
  const char *ssid, *pass;
  uint8_t ip[4], mask[4];
} NETS[] = {
  { SECRET_SSID_HOME,    SECRET_PASS_HOME,    {0,0,0,0},      {0,0,0,0} },
  { SECRET_SSID_SCHOOL,  SECRET_PASS_SCHOOL,  {0,0,0,0},      {0,0,0,0} },
  { SECRET_SSID_HOTSPOT, SECRET_PASS_HOTSPOT, {172,20,10,9},  {255,255,255,240} },
  // MW45AF hotspot: gateway .1, DHCP pool starts high, so .10/.11 are free.
  // IMPORTANT NOTE: 192.168.1.x is also the school UniFi's subnet -- on the
  // school wifi blackout-cam.local is the only address that means anything.
  { SECRET_SSID_ROUTER,  SECRET_PASS_ROUTER,  {192,168,1,9},  {255,255,255,0} },
};

#define WIFI_RETRY_MS 10000

// One join attempt. The radio is cycled off and the NVS copy of the credentials
// wiped first: a failed join leaves the driver holding the state that just
// failed, and ESP.restart() is a soft reset that inherits it — which is why the
// old "reboot in 5s to retry" loop retried forever and only a finger on the RST
// button ever got the cam onto the hotspot.
#if CAM_NETWORK != NET_NONE
static void wifiJoin() {
  const auto &net = NETS[CAM_NETWORK];
  WiFi.persistent(false);
  WiFi.disconnect(true, true);
  WiFi.mode(WIFI_OFF);
  delay(100);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);          // modem sleep costs frames on a stream anyway
  WiFi.setAutoReconnect(true);
  const bool statik = camSlot && net.ip[3];
  Serial.printf("joining [%s]%s\n", net.ssid, statik ? " (static IP)" : " (DHCP)");
  if (statik) {
    IPAddress ip(net.ip[0], net.ip[1], net.ip[2], net.ip[3] + camSlot);
    IPAddress gw(net.ip[0], net.ip[1], net.ip[2], 1);
    if (!WiFi.config(ip, gw, IPAddress(net.mask[0], net.mask[1], net.mask[2], net.mask[3]), gw))
      Serial.println("WiFi.config failed — falling back to DHCP");
  }
  WiFi.begin(net.ssid, net.pass);
}
#endif

// ---- ai-thinker pinout ----
#define PWDN_GPIO_NUM  32
#define RESET_GPIO_NUM -1
#define XCLK_GPIO_NUM   0
#define SIOD_GPIO_NUM  26
#define SIOC_GPIO_NUM  27
#define Y9_GPIO_NUM    35
#define Y8_GPIO_NUM    34
#define Y7_GPIO_NUM    39
#define Y6_GPIO_NUM    36
#define Y5_GPIO_NUM    21
#define Y4_GPIO_NUM    19
#define Y3_GPIO_NUM    18
#define Y2_GPIO_NUM     5
#define VSYNC_GPIO_NUM 25
#define HREF_GPIO_NUM  23
#define PCLK_GPIO_NUM  22

// ---- http handlers ----
// /stream lives on its own server on :81 and its handler never returns, so there is
// only ever one stream
#define PART_BOUNDARY "123456789000000000000987654321"
static const char* STREAM_CT = "multipart/x-mixed-replace;boundary=" PART_BOUNDARY;
static const char* STREAM_BOUNDARY = "\r\n--" PART_BOUNDARY "\r\n";
static const char* STREAM_PART = "Content-Type: image/jpeg\r\nContent-Length: %u\r\n\r\n";

static esp_err_t capture_handler(httpd_req_t* req) {
  camera_fb_t* fb = esp_camera_fb_get();
  if (!fb) { httpd_resp_send_500(req); return ESP_FAIL; }
  httpd_resp_set_type(req, "image/jpeg");
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  esp_err_t r = httpd_resp_send(req, (const char*)fb->buf, fb->len);
  esp_camera_fb_return(fb);
  return r;
}

static esp_err_t stream_handler(httpd_req_t* req) {
  httpd_resp_set_type(req, STREAM_CT);
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  char part[64];
  while (true) {
    camera_fb_t* fb = esp_camera_fb_get();
    if (!fb) return ESP_FAIL;

    if (httpd_resp_send_chunk(req, STREAM_BOUNDARY, strlen(STREAM_BOUNDARY)) != ESP_OK ||
        httpd_resp_send_chunk(req, part, snprintf(part, sizeof(part), STREAM_PART, fb->len)) != ESP_OK ||
        httpd_resp_send_chunk(req, (const char*)fb->buf, fb->len) != ESP_OK) {
      esp_camera_fb_return(fb);
      break;
    }
    esp_camera_fb_return(fb);
  }
  return ESP_OK;
}

// one setter table, because the usb path sets the same things the http one does
static int camSet(const char* var, int v) {
  sensor_t* s = esp_camera_sensor_get();
  if (!s) return -1;
  int ok = -1;
  if      (!strcmp(var, "framesize"))    ok = s->set_framesize(s, (framesize_t)v);
  else if (!strcmp(var, "brightness"))   ok = s->set_brightness(s, v);
  else if (!strcmp(var, "contrast"))     ok = s->set_contrast(s, v);
  else if (!strcmp(var, "saturation"))   ok = s->set_saturation(s, v);
  else if (!strcmp(var, "sharpness"))    ok = s->set_sharpness(s, v);
  else if (!strcmp(var, "special_effect")) ok = s->set_special_effect(s, v);
  else if (!strcmp(var, "whitebal"))     ok = s->set_whitebal(s, v);
  else if (!strcmp(var, "awb_gain"))     ok = s->set_awb_gain(s, v);
  else if (!strcmp(var, "wb_mode"))      ok = s->set_wb_mode(s, v);
  else if (!strcmp(var, "exposure_ctrl")) ok = s->set_exposure_ctrl(s, v);
  else if (!strcmp(var, "ae_level"))     ok = s->set_ae_level(s, v);
  else if (!strcmp(var, "aec_value"))    ok = s->set_aec_value(s, v);
  else if (!strcmp(var, "gain_ctrl"))    ok = s->set_gain_ctrl(s, v);
  else if (!strcmp(var, "agc_gain"))     ok = s->set_agc_gain(s, v);
  else if (!strcmp(var, "gainceiling"))  ok = s->set_gainceiling(s, (gainceiling_t)v);
  else if (!strcmp(var, "raw_gma"))      ok = s->set_raw_gma(s, v);
  else if (!strcmp(var, "lenc"))         ok = s->set_lenc(s, v);
  else if (!strcmp(var, "dcw"))          ok = s->set_dcw(s, v);
  else if (!strcmp(var, "hmirror"))      ok = s->set_hmirror(s, v);
  else if (!strcmp(var, "vflip"))        ok = s->set_vflip(s, v);
  else if (!strcmp(var, "colorbar"))     ok = s->set_colorbar(s, v);
  else if (!strcmp(var, "led"))          { ledcWrite(LED_PIN, v); ok = 0; }
  return ok == -1 ? -1 : v;
}

static esp_err_t control_handler(httpd_req_t* req) {
  char buf[64] = {0}, var[32] = {0}, val[16] = {0};
  if (httpd_req_get_url_query_str(req, buf, sizeof(buf)) != ESP_OK)
    { httpd_resp_send_500(req); return ESP_FAIL; }
  httpd_query_key_value(buf, "var", var, sizeof(var));
  httpd_query_key_value(buf, "val", val, sizeof(val));
  int n = snprintf(buf, sizeof(buf), "OK:%s=%d", var, camSet(var, atoi(val)));
  httpd_resp_set_type(req, "text/plain");
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  httpd_resp_send(req, buf, n);
  return ESP_OK;
}

// ---- the usb side ----
// One frame per request, never a free-running push: the PC drains at its own
// pace and an unread port can never back up into loop(). "f" = one frame,
// "v <var> <val>" = the same setter /control drives. A frame goes out as a
// "#JPG <len>" line and then exactly len raw bytes -- the length is what makes
// it parseable, since jpeg payload can spell any marker you pick.
static void serialTick() {
  static char line[48];
  static uint8_t n = 0;
  while (Serial.available()) {
    char ch = Serial.read();
    if (ch != '\n' && ch != '\r') { if (n < sizeof(line) - 1) line[n++] = ch; continue; }
    line[n] = 0; n = 0;
    if (line[0] == 'f') {
      camera_fb_t* fb = esp_camera_fb_get();
      if (!fb) { Serial.println("#ERR no frame"); continue; }
      Serial.printf("\n#JPG %u\n", fb->len);
      Serial.write(fb->buf, fb->len);
      esp_camera_fb_return(fb);
    } else if (line[0] == 'v') {
      char var[32]; int val;
      if (sscanf(line + 1, "%31s %d", var, &val) == 2)
        Serial.printf("#OK %s=%d\n", var, camSet(var, val));
    }
  }
}

void startServer() {
  httpd_handle_t main_srv = NULL, stream_srv = NULL;

  httpd_config_t mc = HTTPD_DEFAULT_CONFIG();
  httpd_uri_t capture_uri = { "/capture", HTTP_GET, capture_handler, NULL };
  httpd_uri_t control_uri = { "/control", HTTP_GET, control_handler, NULL };
  if (httpd_start(&main_srv, &mc) == ESP_OK) {
    httpd_register_uri_handler(main_srv, &capture_uri);
    httpd_register_uri_handler(main_srv, &control_uri);
  }

  httpd_config_t sc = HTTPD_DEFAULT_CONFIG();
  sc.server_port = 81;
  sc.ctrl_port   = 32769;

  sc.lru_purge_enable  = true;
  sc.send_wait_timeout = 2;
  sc.recv_wait_timeout = 2;
  httpd_uri_t stream_uri = { "/stream", HTTP_GET, stream_handler, NULL };
  if (httpd_start(&stream_srv, &sc) == ESP_OK)
    httpd_register_uri_handler(stream_srv, &stream_uri);
}

// ---- setup ----
void setup() {
  Serial.begin(CAM_BAUD);
  ledcAttach(LED_PIN, 5000, 8); ledcWrite(LED_PIN, 0);
  camIdentify();   // before the camera init, so a bad ribbon can't hide the id

  camera_config_t c = {};
  c.ledc_channel = LEDC_CHANNEL_0; c.ledc_timer = LEDC_TIMER_0;
  c.pin_d0=Y2_GPIO_NUM; c.pin_d1=Y3_GPIO_NUM; c.pin_d2=Y4_GPIO_NUM; c.pin_d3=Y5_GPIO_NUM;
  c.pin_d4=Y6_GPIO_NUM; c.pin_d5=Y7_GPIO_NUM; c.pin_d6=Y8_GPIO_NUM; c.pin_d7=Y9_GPIO_NUM;
  c.pin_xclk=XCLK_GPIO_NUM; c.pin_pclk=PCLK_GPIO_NUM; c.pin_vsync=VSYNC_GPIO_NUM; c.pin_href=HREF_GPIO_NUM;
  c.pin_sccb_sda=SIOD_GPIO_NUM; c.pin_sccb_scl=SIOC_GPIO_NUM;
  c.pin_pwdn=PWDN_GPIO_NUM; c.pin_reset=RESET_GPIO_NUM;
  c.xclk_freq_hz = 20000000;
  c.pixel_format = PIXFORMAT_JPEG;

  if (psramFound()) { c.frame_size = FRAMESIZE_SVGA; c.jpeg_quality = 10; c.fb_count = 2; }
  else              { c.frame_size = FRAMESIZE_QVGA; c.jpeg_quality = 15; c.fb_count = 1; }

  c.grab_mode = CAMERA_GRAB_LATEST;

  bool camOk = esp_camera_init(&c) == ESP_OK;
  if (!camOk) { Serial.println("camera init failed — check ribbon cable seating / power"); ledMode = LED_ERROR; }

  if (camOk) {
    sensor_t* s = esp_camera_sensor_get();
    s->set_vflip(s, 1);
    s->set_hmirror(s, 1);
    s->set_brightness(s, -1);
    s->set_contrast(s, -1);

    s->set_whitebal(s, 1);
    s->set_awb_gain(s, 1);
    s->set_wb_mode(s, 0);
  }

#if CAM_NETWORK != NET_NONE
  wifiJoin();
  for (int i = 0; i < 30 && WiFi.status() != WL_CONNECTED; i++) {
    for (int j = 0; j < 10; j++) { delay(50); ledUpdate(); }
    Serial.printf("st=%d\n", WiFi.status());
  }
  if (WiFi.status() != WL_CONNECTED) {
    Serial.printf("WiFi FAILED, status=%d — 1=SSID-not-found 4=bad-password\n", WiFi.status());
    ledMode = LED_ERROR;
    Serial.println("loop() keeps retrying — no reset needed");
  }
  const bool netOk = WiFi.status() == WL_CONNECTED;
#else
  const bool netOk = true;   // the cable is the network
#endif

  if (camOk && netOk) {
    ledMode = LED_CONNECTED;
    for (int i = 0; i < 40; i++) { delay(50); ledUpdate(); }
  }
  ledcWrite(LED_PIN, 0);
  Serial.printf("\ncam=%s\n", camOk ? "OK" : "FAIL");
  if (!camSlot) Serial.println("UNCLAIMED — paste the chip id above into CAM_CHIPS and reflash");
#if CAM_NETWORK != NET_NONE
  if (camOk) Serial.println("stream: :81/stream   capture: /capture");
  startServer();   // binds 0.0.0.0, so it does not care whether wifi is up yet
#else
  // startServer() is still compiled -- it is what keeps the http handlers
  // referenced, and flipping CAM_NETWORK back is then one word, not a rebuild of
  // half the sketch.
  if (camOk) Serial.println("serial only: \"f\" = one frame, \"v <var> <val>\" = a setting");
#endif
}

// The hotspot is not guaranteed to be up when the cam is, and it can go away
// mid-run — so joining is a thing loop() keeps doing, not a one-shot in setup().
// The lamp stays out of it: once setup() returns the lamp belongs to
// control?var=led, and a blinking lamp on a booted cam means the headlamp, never
// the network.
void loop() {
#if CAM_NETWORK != NET_NONE
  static bool up = false;
  static unsigned long lastTry = 0;
  if (WiFi.status() == WL_CONNECTED) {
    if (!up) {
      up = true;
      MDNS.begin(camName);
      Serial.printf("net up: http://%s (%s.local)\n",
                    WiFi.localIP().toString().c_str(), camName);
    }
  } else if (millis() - lastTry >= WIFI_RETRY_MS) {
    if (up) { up = false; MDNS.end(); Serial.println("wifi dropped"); }
    lastTry = millis();
    wifiJoin();
  }
#endif
  serialTick();   // the usb cable works with the radio down, so it is polled either way
  delay(2);
}
