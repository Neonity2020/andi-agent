import { throwIfAborted } from "../runtime/abort";
import type { Tool } from "./types";
import { requireRecord, requireString } from "./validation";

const MAX_QUERY_LENGTH = 200;
const MAX_RESULT_SIZE = 8_000;

interface GeoResult {
  name: string;
  country: string;
  latitude: number;
  longitude: number;
  timezone: string;
}

interface WeatherCurrent {
  time: string;
  temperature_2m: number;
  relative_humidity_2m: number;
  apparent_temperature: number;
  weather_code: number;
  wind_speed_10m: number;
  wind_direction_10m: number;
}

interface WeatherDaily {
  time: string[];
  temperature_2m_max: number[];
  temperature_2m_min: number[];
  weather_code: number[];
  precipitation_sum: number[];
  wind_speed_10m_max: number[];
}

interface WeatherResponse {
  current: WeatherCurrent;
  daily: WeatherDaily;
}

function weatherCodeDescription(code: number): string {
  const map: Record<number, string> = {
    0: "晴朗",
    1: "主要晴朗",
    2: "局部多云",
    3: "阴天",
    45: "雾",
    48: "结冰雾",
    51: "轻毛毛雨",
    53: "中度毛毛雨",
    55: "密集毛毛雨",
    56: "轻冻毛毛雨",
    57: "密集冻毛毛雨",
    61: "小雨",
    63: "中雨",
    65: "大雨",
    66: "轻冻雨",
    67: "重冻雨",
    71: "小雪",
    73: "中雪",
    75: "大雪",
    77: "雪粒",
    80: "小阵雨",
    81: "中阵雨",
    82: "大阵雨",
    85: "小阵雪",
    86: "大阵雪",
    95: "雷暴",
    96: "雷暴伴冰雹",
    99: "强雷暴伴冰雹",
  };
  return map[code] ?? `天气代码 ${code}`;
}

function windDirection(degrees: number): string {
  const dirs = ["北", "东北", "东", "东南", "南", "西南", "西", "西北"];
  return dirs[Math.round(degrees / 45) % 8] ?? "未知方向";
}

function formatWeather(geo: GeoResult, data: WeatherResponse): string {
  const cur = data.current;
  const lines: string[] = [
    `📍 ${geo.name}，${geo.country}（${geo.latitude.toFixed(2)}°N，${geo.longitude.toFixed(2)}°E）`,
    `🌡️ 当前：${cur.temperature_2m}°C（体感 ${cur.apparent_temperature}°C）`,
    `☁️ 天气：${weatherCodeDescription(cur.weather_code)}`,
    `💧 湿度：${cur.relative_humidity_2m}%`,
    `💨 风速：${cur.wind_speed_10m} km/h，风向 ${windDirection(cur.wind_direction_10m)}`,
    `🕐 更新时间：${cur.time}`,
  ];

  const todayDate = cur.time.slice(0, 10);
  const todayIndex = data.daily.time.findIndex((t) => t === todayDate);
  if (todayIndex >= 0) {
    lines.push("");
    lines.push("📅 未来三天预报：");
    for (let i = todayIndex; i < Math.min(todayIndex + 3, data.daily.time.length); i++) {
      const max = data.daily.temperature_2m_max[i];
      const min = data.daily.temperature_2m_min[i];
      const code = data.daily.weather_code[i];
      const precip = data.daily.precipitation_sum[i];
      const wind = data.daily.wind_speed_10m_max[i];
      const date = data.daily.time[i];
      if (max === undefined || min === undefined || code === undefined) continue;
      if (precip === undefined || wind === undefined || date === undefined) continue;
      lines.push(
        `${date}  ${weatherCodeDescription(code)}  ${min}°C ~ ${max}°C  ` +
          `降水 ${precip}mm  风速 ${wind}km/h`,
      );
    }
  }

  return lines.join("\n").slice(0, MAX_RESULT_SIZE);
}

interface WeatherToolOptions {
  fetcher?: typeof fetch;
}

async function geocodeCity(city: string, fetcher: typeof fetch): Promise<GeoResult> {
  const resp = await fetcher(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=zh&format=json`,
  );
  if (!resp.ok) throw new Error(`Geocoding request failed (${resp.status})`);
  const json = (await resp.json()) as unknown;
  if (!isRecord(json) || !Array.isArray(json.results) || json.results.length === 0) {
    throw new Error(`未找到城市 "${city}"，请检查名称是否正确`);
  }
  const results = json.results;
  if (!Array.isArray(results) || results.length === 0) {
    throw new Error(`未找到城市 "${city}"，请检查名称是否正确`);
  }
  const item = results[0];
  if (!item || typeof item.name !== "string" || typeof item.latitude !== "number" || typeof item.longitude !== "number") {
    throw new Error("Geocoding result is missing required fields");
  }
  const lat = item.latitude;
  const lon = item.longitude;
  return {
    latitude: lat,
    longitude: lon,
    name: item.name,
    country: typeof item.country === "string" ? item.country : "",
    timezone: typeof item.timezone === "string" ? item.timezone : "UTC",
  };
}

async function fetchWeather(
  lat: number,
  lon: number,
  timezone: string,
  fetcher: typeof fetch,
): Promise<WeatherResponse> {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    current: "temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,wind_direction_10m,precipitation",
    daily: "temperature_2m_max,temperature_2m_min,weather_code,precipitation_sum,wind_speed_10m_max",
    timezone,
    forecast_days: "3",
  });
  const resp = await fetcher(`https://api.open-meteo.com/v1/forecast?${params}`);
  if (!resp.ok) throw new Error(`Weather request failed (${resp.status})`);
  const json = (await resp.json()) as unknown;
  if (!isRecord(json)) throw new Error("Weather API returned invalid JSON");
  return json as unknown as WeatherResponse;
}

export function createWeatherTool(options: WeatherToolOptions = {}): Tool {
  const fetcher = options.fetcher ?? fetch;
  return {
    name: "weather",
    description:
      "查询指定城市的当前天气和未来三天预报。输入城市中文名或英文名（如沈阳、Shenyang、北京、Tokyo）。返回温度、体感温度、天气状况、湿度、风速及未来三日预报。",
    parameters: {
      type: "object",
      properties: {
        city: { type: "string", description: "城市名称（中文或英文）" },
      },
      required: ["city"],
      additionalProperties: false,
    },
    async execute(input: unknown, context) {
      throwIfAborted(context?.signal);
      const values = requireRecord(input);
      const city = requireString(values as unknown as Record<string, unknown>, "city");
      if (city.trim().length === 0 || city.length > MAX_QUERY_LENGTH) {
        throw new Error(`city 必须为 1-${MAX_QUERY_LENGTH} 个字符的非空字符串`);
      }
      const geo = await geocodeCity(city.trim(), fetcher);
      const weather = await fetchWeather(geo.latitude, geo.longitude, geo.timezone, fetcher);
      return formatWeather(geo, weather);
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
