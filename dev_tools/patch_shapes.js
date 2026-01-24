const fs = require("fs");
const path = require("path");

const shapesPath = path.join(__dirname, "..", "shapes.json");
const manualShapesPath = path.join(__dirname, "manual_shapes.json");

function patch() {
  if (!fs.existsSync(shapesPath)) {
    console.error(
      "Error: shapes.json が見つかりません。まず convert_to_json.js を一度完了させる必要があります。",
    );
    return;
  }
  if (!fs.existsSync(manualShapesPath)) {
    console.error("Error: manual_shapes.json が見つかりません。");
    return;
  }

  const shapes = JSON.parse(fs.readFileSync(shapesPath, "utf-8"));
  const manualShapes = JSON.parse(fs.readFileSync(manualShapesPath, "utf-8"));

  const segmentOverrides = {};
  Object.entries(manualShapes).forEach(([key, data]) => {
    if (key.includes("|...|")) {
      const [startId, endId] = key.split("|...|");
      segmentOverrides[`${startId}|${endId}`] = data.coordinates;
    }
  });

  console.log("🚀 高速パッチを開始します...");

  let patchCount = 0;
  Object.keys(shapes).forEach((patternKey) => {
    const stopIds = patternKey.split("|");
    let currentPattern = shapes[patternKey];
    let wasModified = false;

    // 完全一致の上書きがあれば適用
    if (manualShapes[patternKey] && !patternKey.includes("|...|")) {
      shapes[patternKey] = manualShapes[patternKey];
      patchCount++;
      return;
    }

    // 部分置換を適用
    Object.entries(segmentOverrides).forEach(([segKey, newCoords]) => {
      const [startId, endId] = segKey.split("|");
      const startIndex = stopIds.indexOf(startId);
      const endIndex = stopIds.indexOf(endId);

      if (startIndex !== -1 && endIndex !== -1 && startIndex < endIndex) {
        const startCoordIdx = currentPattern.stop_indices[startIndex];
        const endCoordIdx = currentPattern.stop_indices[endIndex];

        const head = currentPattern.coordinates.slice(0, startCoordIdx);
        const tail = currentPattern.coordinates.slice(endCoordIdx + 1);

        currentPattern.coordinates = [...head, ...newCoords, ...tail];

        const diff = newCoords.length - (endCoordIdx - startCoordIdx + 1);
        for (let i = endIndex; i < currentPattern.stop_indices.length; i++) {
          currentPattern.stop_indices[i] += diff;
        }
        wasModified = true;
      }
    });

    if (wasModified) patchCount++;
  });

  fs.writeFileSync(shapesPath, JSON.stringify(shapes));
  console.log(
    `\n✅ 完了！ ${patchCount} 個のルートを瞬時にアップデートしました。`,
  );
}

try {
  patch();
} catch (e) {
  console.error("Patch error:", e.message);
}
