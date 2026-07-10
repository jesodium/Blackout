// ESP32-CAM (AI-Thinker) — standalone MJPEG streamer. Own WiFi, own power.
// Never touches the Uno/BLE path: dashboard grabs the stream over HTTP direct.
// Stream URL after boot: http://blackout-cam.local/stream (or the IP printed
// on serial). Single file on purpose — this is all Espressif's 4-file
// CameraWebServer example does for a plain MJPEG feed.
#include "esp_camera.h"
#include <WiFi.h>
#include <ESPmDNS.h>
#include "esp_http_server.h"
#include "arduino_secrets.h"  // SECRET_SSID / SECRET_PASS — gitignored, copy from .example

#define MDNS_NAME "blackout-cam"   // -> http://blackout-cam.local/stream

// AI-Thinker ESP32-CAM pin map (don't change unless you have a different board)
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

#define PART_BOUNDARY "123456789000000000000987654321"
static const char* STREAM_CT = "multipart/x-mixed-replace;boundary=" PART_BOUNDARY;
static const char* STREAM_BOUNDARY = "\r\n--" PART_BOUNDARY "\r\n";
static const char* STREAM_PART = "Content-Type: image/jpeg\r\nContent-Length: %u\r\n\r\n";

static esp_err_t stream_handler(httpd_req_t* req) {
  httpd_resp_set_type(req, STREAM_CT);
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  char part[64];
  while (true) {
    camera_fb_t* fb = esp_camera_fb_get();
    if (!fb) return ESP_FAIL;
    // send boundary, header, jpeg. Any failure = client gone, stop.
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

void startServer() {
  httpd_config_t config = HTTPD_DEFAULT_CONFIG();
  httpd_handle_t server = NULL;
  httpd_uri_t stream_uri = { "/stream", HTTP_GET, stream_handler, NULL };
  if (httpd_start(&server, &config) == ESP_OK)
    httpd_register_uri_handler(server, &stream_uri);
}

void setup() {
  Serial.begin(115200);

  camera_config_t c = {};
  c.ledc_channel = LEDC_CHANNEL_0; c.ledc_timer = LEDC_TIMER_0;
  c.pin_d0=Y2_GPIO_NUM; c.pin_d1=Y3_GPIO_NUM; c.pin_d2=Y4_GPIO_NUM; c.pin_d3=Y5_GPIO_NUM;
  c.pin_d4=Y6_GPIO_NUM; c.pin_d5=Y7_GPIO_NUM; c.pin_d6=Y8_GPIO_NUM; c.pin_d7=Y9_GPIO_NUM;
  c.pin_xclk=XCLK_GPIO_NUM; c.pin_pclk=PCLK_GPIO_NUM; c.pin_vsync=VSYNC_GPIO_NUM; c.pin_href=HREF_GPIO_NUM;
  c.pin_sccb_sda=SIOD_GPIO_NUM; c.pin_sccb_scl=SIOC_GPIO_NUM;
  c.pin_pwdn=PWDN_GPIO_NUM; c.pin_reset=RESET_GPIO_NUM;
  c.xclk_freq_hz = 20000000;
  c.pixel_format = PIXFORMAT_JPEG;
  // PSRAM present (most AI-Thinker boards): bigger frame + double buffer.
  // No PSRAM: drop to smaller frame so it fits, or camera_init fails.
  // IMPORTANT NOTE: quality/res knobs. frame_size bigger + jpeg_quality lower
  // (=better) both cost WiFi bandwidth -> lower FPS. SVGA@10 is the sweet spot
  // for a moving robot; go XGA/UXGA only if you want stills over motion.
  // frame_size does NOT change field of view — that's the lens (see below).
  if (psramFound()) { c.frame_size = FRAMESIZE_SVGA; c.jpeg_quality = 10; c.fb_count = 2; }
  else              { c.frame_size = FRAMESIZE_QVGA; c.jpeg_quality = 15; c.fb_count = 1; }

  // Don't bail on camera failure — bring WiFi up first so the board is always
  // reachable and can report *why* it's broken. A bare `return` here made a
  // loose ribbon indistinguishable from a dead board (silent on every channel).
  bool camOk = esp_camera_init(&c) == ESP_OK;
  if (!camOk) Serial.println("camera init failed — check ribbon cable seating / power");

  // DIAGNOSTIC: scan first so we can see whether the target SSID is even on air
  // and compare its name byte-for-byte with SECRET_SSID (apostrophe gotchas).
  Serial.printf("looking for SSID=[%s]\n", SECRET_SSID);
  int nfound = WiFi.scanNetworks();
  for (int i = 0; i < nfound; i++)
    Serial.printf("  seen: [%s] rssi=%d ch=%d\n",
                  WiFi.SSID(i).c_str(), WiFi.RSSI(i), WiFi.channel(i));

  WiFi.begin(SECRET_SSID, SECRET_PASS);
  for (int i = 0; i < 30 && WiFi.status() != WL_CONNECTED; i++) {
    delay(500); Serial.printf(" st=%d", WiFi.status()); // 1=NO_SSID 4=FAIL 6=DISCONNECT
  }
  if (WiFi.status() != WL_CONNECTED) {
    Serial.printf("\nWiFi FAILED, status=%d — 1=SSID-not-found 4=bad-password\n", WiFi.status());
    return;
  }
  MDNS.begin(MDNS_NAME);
  Serial.printf("\nnet up: http://%s  cam=%s\n",
                WiFi.localIP().toString().c_str(), camOk ? "OK" : "FAIL");
  if (camOk) Serial.println("stream: /stream");
  startServer();
}

void loop() { delay(1000); }  // all work is in the HTTP handler
