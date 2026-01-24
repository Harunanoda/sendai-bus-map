const fs = require("fs");
const { parse } = require("csv-parse/sync");
const axios = require("axios");
const path = require("path");

// フォルダパスの設定
const inputDir = "gtfs_raw";
const outputDir = ".";

async function start() {
  console.log("🚀 全路線の解析と道路形状の生成を開始します...");
  console.log("※全路線の処理には10分以上かかる場合があります。");

  const read = (file) => {
    const filePath = path.join(inputDir, file);
    if (!fs.existsSync(filePath)) return [];
    return parse(fs.readFileSync(filePath, "utf-8"), {
      columns: true,
      skip_empty_lines: true,
    });
  };

  const calendar = read("calendar.txt");
  const calendarDates = read("calendar_dates.txt");
  const offices = read("office_jp.txt");
  const patterns = read("pattern_jp.txt");
  const routes = read("routes.txt");
  const stopTimes = read("stop_times.txt");
  const stops = read("stops.txt");
  const trips = read("trips.txt");

  // 全ての Route ID を取得
  const targetRouteIds = routes.map((r) => r.route_id);

  const stopsJson = {};
  stops.forEach((s) => {
    stopsJson[s.stop_id] = {
      name: s.stop_name,
      lat: parseFloat(s.stop_lat),
      lng: parseFloat(s.stop_lon),
      platform: s.platform_code || "",
    };
  });

  const routesJson = {};
  routes.forEach((r) => {
    routesJson[r.route_id] = {
      short_name: r.route_short_name,
      color: r.route_color || "00703c",
      office_id: r.jp_office_id,
    };
  });

  const officeMap = {};
  offices.forEach((o) => (officeMap[o.office_id] = o.office_name));

  const patternMap = {};
  patterns.forEach((p) => {
    patternMap[p.jp_pattern_id] = p.via_stop || "";
  });

  const calendarJson = {};
  calendar.forEach((c) => {
    calendarJson[c.service_id] = {
      days: [
        c.monday,
        c.tuesday,
        c.wednesday,
        c.thursday,
        c.friday,
        c.saturday,
        c.sunday,
      ],
      start: c.start_date,
      end: c.end_date,
    };
  });

  const stopTimesMap = new Map();
  stopTimes.forEach((st) => {
    if (!stopTimesMap.has(st.trip_id)) stopTimesMap.set(st.trip_id, []);
    stopTimesMap.get(st.trip_id).push(st);
  });

  const timetablesJson = {};
  const shapesToGenerate = new Map();
  const validTrips = trips.filter((t) => targetRouteIds.includes(t.route_id));

  validTrips.forEach((trip) => {
    const routeId = trip.route_id;
    if (!timetablesJson[routeId]) timetablesJson[routeId] = {};
    const myStopTimes = (stopTimesMap.get(trip.trip_id) || []).sort(
      (a, b) => parseInt(a.stop_sequence) - parseInt(b.stop_sequence),
    );
    if (myStopTimes.length < 2) return;

    timetablesJson[routeId][trip.trip_id] = {
      headsign: trip.trip_headsign,
      service_id: trip.service_id,
      office_id: trip.jp_office_id,
      via: patternMap[trip.jp_pattern_id] || "",
      stops: myStopTimes.map((st) => ({
        time: st.departure_time,
        stop_id: st.stop_id,
      })),
    };
    const patternKey = myStopTimes.map((s) => s.stop_id).join("|");
    if (!shapesToGenerate.has(patternKey)) {
      shapesToGenerate.set(patternKey, {
        route_id: routeId,
        headsign: trip.trip_headsign,
        stops: myStopTimes,
      });
    }
  });

  // 手動修正データの読み込み
  const manualShapesPath = path.join(__dirname, "manual_shapes.json");
  let manualShapes = {};
  if (fs.existsSync(manualShapesPath)) {
    manualShapes = JSON.parse(fs.readFileSync(manualShapesPath, "utf-8"));
  }

  const shapesJson = {};
  console.log(`🌐 ${shapesToGenerate.size} パターンの道路形状を生成します...`);
  let counter = 1;
  for (const [patternKey, info] of shapesToGenerate) {
    if (manualShapes[patternKey]) {
      process.stdout.write(
        `\r   [${counter}/${shapesToGenerate.size}] [手動データを使用] ${info.headsign} 行...      `,
      );
      shapesJson[patternKey] = manualShapes[patternKey];
      counter++;
      continue;
    }

    process.stdout.write(
      `\r   [${counter}/${shapesToGenerate.size}] 生成中: ${info.headsign} 行...      `,
    );
    const stopCoords = info.stops.map((st) => stopsJson[st.stop_id]);
    let fullCoordinates = [];
    let stopIndices = [];
    const chunkSize = 20;

    for (let i = 0; i < stopCoords.length - 1; i += chunkSize) {
      const chunk = stopCoords.slice(i, i + chunkSize + 1);
      const coordsStr = chunk.map((c) => `${c.lng},${c.lat}`).join(";");
      try {
        const url = `https://router.project-osrm.org/route/v1/driving/${coordsStr}?overview=full&geometries=geojson`;
        const res = await axios.get(url);
        if (res.data.code === "Ok") {
          const segmentCoords = res.data.routes[0].geometry.coordinates;
          if (fullCoordinates.length > 0) segmentCoords.shift();
          fullCoordinates = fullCoordinates.concat(segmentCoords);
        }
      } catch (e) {}
    }

    stopIndices = [];
    stopCoords.forEach((stop, idx) => {
      let closestDist = Infinity;
      let closestIdx = 0;
      let searchStart =
        stopIndices.length > 0 ? stopIndices[stopIndices.length - 1] : 0;
      for (let i = searchStart; i < fullCoordinates.length; i++) {
        const p = fullCoordinates[i];
        const d = Math.pow(p[0] - stop.lng, 2) + Math.pow(p[1] - stop.lat, 2);
        if (d < closestDist) {
          closestDist = d;
          closestIdx = i;
        }
      }
      stopIndices.push(closestIdx);
    });

    shapesJson[patternKey] = {
      coordinates: fullCoordinates,
      stop_indices: stopIndices,
    };
    // 1.5秒待機 (無料サーバーをパンクさせないためのマナー)
    await new Promise((r) => setTimeout(r, 1500));
    counter++;
  }

  // 2. shapes.json を全ルートについて再生成（各系統、各行き先、各運行パターンごと）
  const finalShapes = {};

  // 部分置換データの準備（A|...|B 形式を抽出）
  const segmentOverrides = {};
  Object.entries(manualShapes).forEach(([key, data]) => {
    if (key.includes("|...|")) {
      const [startId, endId] = key.split("|...|");
      segmentOverrides[`${startId}|${endId}`] = data.coordinates;
    } else {
      // 通常のPatterKey完全一致データはshapesJsonに既に含まれている
      // finalShapes[key] = data; // この行は不要、shapesJsonからコピーされる
    }
  });

  // shapesJsonを元にfinalShapesを初期化
  for (const [patternKey, data] of Object.entries(shapesJson)) {
    finalShapes[patternKey] = { ...data }; // コピーして変更に備える
  }

  // shapesToGenerate を routeId -> headsign -> patternKey の構造に変換
  const routeData = {};
  for (const [patternKey, info] of shapesToGenerate) {
    if (!routeData[info.route_id]) routeData[info.route_id] = {};
    if (!routeData[info.route_id][info.headsign])
      routeData[info.route_id][info.headsign] = {};
    routeData[info.route_id][info.headsign][patternKey] = {
      coordinates: shapesJson[patternKey].coordinates,
      stop_indices: shapesJson[patternKey].stop_indices,
      stops: info.stops, // 元のstops情報も必要
    };
  }

  Object.entries(routeData).forEach(([routeId, destinations]) => {
    Object.entries(destinations).forEach(([destName, patterns]) => {
      Object.entries(patterns).forEach(([patternKey, pattern]) => {
        // すでに完全一致の manualShapes がある場合はスキップ（上記でshapesJsonに代入済み）
        if (manualShapes[patternKey] && !patternKey.includes("|...|")) {
          finalShapes[patternKey] = manualShapes[patternKey];
          return;
        }

        let currentCoordinates = [...pattern.coordinates]; // 変更可能なコピー
        let currentStopIndices = [...pattern.stop_indices]; // 変更可能なコピー
        const stopIds = patternKey.split("|");

        // --- 部分置換（セグメント上書き）の適用 ---
        Object.entries(segmentOverrides).forEach(([segKey, newCoords]) => {
          const [startId, endId] = segKey.split("|");
          const startIndex = stopIds.indexOf(startId);
          const endIndex = stopIds.indexOf(endId);

          // 両方のバス停が含まれ、かつ正しい順序である場合のみ置換
          if (startIndex !== -1 && endIndex !== -1 && startIndex < endIndex) {
            console.log(
              `Applying segment override [${segKey}] to PatternKey: ${patternKey.substring(0, 50)}...`,
            );

            // 既存の shapes.json から、置換対象となる区間の座標インデックスを特定
            const startCoordIdx = currentStopIndices[startIndex];
            const endCoordIdx = currentStopIndices[endIndex];

            // 座標列を差し替え
            const head = currentCoordinates.slice(0, startCoordIdx);
            const tail = currentCoordinates.slice(endCoordIdx + 1);
            currentCoordinates = [...head, ...newCoords, ...tail];

            // この上書きによって座標数が変わるため、stop_indices を再計算する必要がある
            // 単純化のため、ここでは「置換された区間以降」のインデックスをずらす処理を行う
            const diff = newCoords.length - (endCoordIdx - startCoordIdx + 1);
            for (let i = endIndex; i < currentStopIndices.length; i++) {
              currentStopIndices[i] += diff;
            }
          }
        });

        finalShapes[patternKey] = {
          coordinates: currentCoordinates,
          stop_indices: currentStopIndices,
        };
      });
    });
  });

  const extraJson = { offices: officeMap, calendar_dates: calendarDates };

  const write = (name, data) =>
    fs.writeFileSync(path.join(outputDir, name), JSON.stringify(data));
  write("stops.json", stopsJson);
  write("routes.json", routesJson);
  write("timetables.json", timetablesJson);
  write("shapes.json", shapesJson);
  write("calendar.json", calendarJson);
  write("extra.json", extraJson);

  console.log("\n\n✅ 完了！すべての路線のデータが作成されました！");
}

start().catch(console.error);
