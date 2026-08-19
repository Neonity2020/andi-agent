import { describe, expect, test } from "bun:test";
import { createWeatherTool } from "../src/tools/weather";

const weatherPayload = {
  current: {
    time: "2026-08-19T12:00",
    temperature_2m: 28,
    relative_humidity_2m: 65,
    apparent_temperature: 30,
    weather_code: 1,
    wind_speed_10m: 12,
    wind_direction_10m: 90,
  },
  daily: {
    time: ["2026-08-19", "2026-08-20", "2026-08-21"],
    temperature_2m_max: [30, 31, 29],
    temperature_2m_min: [22, 23, 21],
    weather_code: [1, 3, 61],
    precipitation_sum: [0, 1.2, 8.4],
    wind_speed_10m_max: [18, 20, 16],
  },
};

describe("weather tool", () => {
  test("queries geocoding and forecast APIs and formats the result", async () => {
    const urls: string[] = [];
    const fetcher = (async (input: URL | RequestInfo) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("geocoding-api.open-meteo.com")) {
        return Response.json({
          results: [
            {
              name: "沈阳",
              country: "中国",
              latitude: 41.8,
              longitude: 123.4,
              timezone: "Asia/Shanghai",
            },
          ],
        });
      }
      return Response.json(weatherPayload);
    }) as unknown as typeof fetch;

    const result = await createWeatherTool({ fetcher }).execute({ city: "沈阳" });

    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain("name=%E6%B2%88%E9%98%B3");
    expect(urls[1]).toContain("timezone=Asia%2FShanghai");
    expect(result).toContain("📍 沈阳，中国");
    expect(result).toContain("🌡️ 当前：28°C（体感 30°C）");
    expect(result).toContain("未来三天预报");
    expect(result).toContain("2026-08-21");
  });

  test("rejects empty or oversized city names before making a request", async () => {
    let calls = 0;
    const fetcher = (async () => {
      calls += 1;
      return Response.json({});
    }) as unknown as typeof fetch;
    const tool = createWeatherTool({ fetcher });

    await expect(tool.execute({ city: " " })).rejects.toThrow("非空字符串");
    await expect(tool.execute({ city: "x".repeat(201) })).rejects.toThrow("非空字符串");
    expect(calls).toBe(0);
  });

  test("honors an aborted request before contacting the API", async () => {
    let calls = 0;
    const fetcher = (async () => {
      calls += 1;
      return Response.json({});
    }) as unknown as typeof fetch;
    const controller = new AbortController();
    controller.abort();

    await expect(createWeatherTool({ fetcher }).execute({ city: "北京" }, { signal: controller.signal })).rejects.toThrow(
      "Operation cancelled",
    );
    expect(calls).toBe(0);
  });
});
