// mjpeg streamer on its own wifi and power. the flash lamp is the boot indicator:
// slow blink booting, fast blink on error, steady dim once connected — setup() only.

#include "esp_camera.h"
#include <WiFi.h>
#include <ESPmDNS.h>
#include "esp_http_server.h"
#include "arduino_secrets.h"

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

// ---- wifi ----
#define MDNS_NAME "blackout-cam"

#define CAM_NETWORK SECRET_SSID_HOTSPOT

#define CAM_USE_STATIC true
IPAddress CAM_IP (172, 20, 10, 10);
IPAddress CAM_GW (172, 20, 10, 1);
IPAddress CAM_MASK(255, 255, 255, 240);

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

static esp_err_t control_handler(httpd_req_t* req) {
  char buf[64] = {0}, var[32] = {0}, val[16] = {0};
  if (httpd_req_get_url_query_str(req, buf, sizeof(buf)) != ESP_OK)
    { httpd_resp_send_500(req); return ESP_FAIL; }
  httpd_query_key_value(buf, "var", var, sizeof(var));
  httpd_query_key_value(buf, "val", val, sizeof(val));
  sensor_t* s = esp_camera_sensor_get();
  if (!s) { httpd_resp_send_500(req); return ESP_FAIL; }
  int v = atoi(val);
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
  int n = snprintf(buf, sizeof(buf), "OK:%s=%d", var, ok == -1 ? -1 : v);
  httpd_resp_set_type(req, "text/plain");
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  httpd_resp_send(req, buf, n);
  return ESP_OK;
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
  Serial.begin(115200);
  ledcAttach(LED_PIN, 5000, 8); ledcWrite(LED_PIN, 0);

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

  const char *ssid = CAM_NETWORK;
  const char *pass =
    ssid == SECRET_SSID_HOME    ? SECRET_PASS_HOME :
    ssid == SECRET_SSID_SCHOOL  ? SECRET_PASS_SCHOOL :
    ssid == SECRET_SSID_HOTSPOT ? SECRET_PASS_HOTSPOT :
    (Serial.println("UNKNOWN SSID — check CAM_NETWORK define"), "");
  Serial.printf("joining [%s]%s\n", ssid, CAM_USE_STATIC ? " (static IP)" : " (DHCP)");
  if (CAM_USE_STATIC && !WiFi.config(CAM_IP, CAM_GW, CAM_MASK, CAM_GW))
    Serial.println("WiFi.config failed — falling back to DHCP");
  WiFi.begin(ssid, pass);
  for (int i = 0; i < 30 && WiFi.status() != WL_CONNECTED; i++) {
    for (int j = 0; j < 10; j++) { delay(50); ledUpdate(); }
    Serial.printf("st=%d\n", WiFi.status());
  }
  if (WiFi.status() != WL_CONNECTED) {
    Serial.printf("WiFi FAILED, status=%d — 1=SSID-not-found 4=bad-password\n", WiFi.status());
    ledMode = LED_ERROR;

    Serial.println("rebooting in 5s to retry...");
    for (int i = 0; i < 100; i++) { delay(50); ledUpdate(); }
    ESP.restart();
  }

  if (camOk) {
    ledMode = LED_CONNECTED;
    for (int i = 0; i < 40; i++) { delay(50); ledUpdate(); }
  }
  ledcWrite(LED_PIN, 0);
  MDNS.begin(MDNS_NAME);
  Serial.printf("\nnet up: http://%s  cam=%s\n",
                WiFi.localIP().toString().c_str(), camOk ? "OK" : "FAIL");
  if (camOk) Serial.println("stream: :81/stream   capture: /capture");
  startServer();
}

void loop() { delay(1000); }
