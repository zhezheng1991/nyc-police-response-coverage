export default async function install(app) {
  const [serviceArea, networkService, ServiceAreaParameters, FeatureSet, Graphic, Portal] = await Promise.all([
    app.import("esri/rest/serviceArea"),
    app.import("esri/rest/networkService"),
    app.import("esri/rest/support/ServiceAreaParameters"),
    app.import("esri/rest/support/FeatureSet"),
    app.import("esri/Graphic"),
    app.import("esri/portal/Portal"),
  ]);
  const mount = app.getMount("coverage-control");
  const stationLayer = app.layers[app.config.stationLayerId];
  app.assert(stationLayer, "The NYPD police station layer is not available.");
  await stationLayer.load();

  const coverage = await app.createResultLayer({
    id: "ten-minute-drive-coverage",
    title: "10-minute driving coverage",
    geometryType: "polygon",
    fields: [
      { name: "Precinct", type: "string" },
      { name: "Minutes", type: "double" }
    ],
    renderer: {
      type: "simple",
      symbol: {
        type: "simple-fill",
        color: [30, 92, 153, 0.18],
        outline: { color: [16, 72, 128, 0.95], width: 2 }
      }
    },
    popupTemplate: {
      title: "{Precinct} precinct — {Minutes}-minute driving coverage",
      content: "Service area generated from the selected NYPD station."
    }
  });

  const heading = document.createElement("p");
  heading.textContent = "Search by precinct, address, or station type—or click a station on the map.";
  heading.style.margin = "0 0 0.75rem";
  heading.style.color = "var(--calcite-color-text-2)";

  const input = document.createElement("calcite-input-text");
  input.setAttribute("placeholder", "Search NYPD stations");
  input.setAttribute("clearable", "");
  input.setAttribute("icon", "magnifying-glass");
  input.setAttribute("scale", "m");

  const list = document.createElement("calcite-list");
  list.setAttribute("label", "NYPD station search results");
  list.setAttribute("selection-mode", "single");
  list.style.marginTop = "0.5rem";

  const status = document.createElement("calcite-notice");
  status.setAttribute("kind", "info");
  status.setAttribute("icon", "information");
  status.open = true;
  const statusTitle = document.createElement("div");
  statusTitle.slot = "title";
  statusTitle.textContent = "10-minute driving coverage";
  const statusMessage = document.createElement("div");
  statusMessage.slot = "message";
  statusMessage.textContent = "Choose a station to calculate its drive-time service area.";
  status.append(statusTitle, statusMessage);
  status.style.marginTop = "0.75rem";

  mount.replaceChildren(heading, input, list, status);
  let stations = [];
  let requestId = 0;
  let selectedGraphic = null;
  let automobileTime = null;

  const makeStationLabel = (graphic) => {
    const a = graphic.attributes ?? {};
    const precinct = a.Precinct ? `${a.Precinct} precinct` : "NYPD station";
    return precinct;
  };
  const renderMatches = (term) => {
    const normalized = String(term ?? "").trim().toLowerCase();
    const matches = normalized.length < 2 ? [] : stations.filter((graphic) => {
      const a = graphic.attributes ?? {};
      return [a.Precinct, a.Address, a.Type, a.Zip_Code].some((value) => String(value ?? "").toLowerCase().includes(normalized));
    }).slice(0, 12);
    list.replaceChildren();
    for (const graphic of matches) {
      const item = document.createElement("calcite-list-item");
      item.value = String(graphic.getObjectId());
      item.setAttribute("label", makeStationLabel(graphic));
      item.setAttribute("description", `${graphic.attributes?.Address ?? "Address unavailable"} · ${graphic.attributes?.Type ?? "Station"}`);
      item.addEventListener("calciteListItemSelect", () => selectStation(graphic));
      list.append(item);
    }
    if (normalized.length >= 2 && matches.length === 0) {
      const item = document.createElement("calcite-list-item");
      item.setAttribute("label", "No matching station");
      item.setAttribute("description", "Try a precinct number, address, or station type.");
      item.setAttribute("unavailable", "");
      list.append(item);
    }
  };

  const chooseDrivingTime = async () => {
    if (automobileTime) return automobileTime;
    const portal = new Portal(app.portalUrl ? { url: app.portalUrl } : {});
    await portal.load();
    const serviceAreaUrl = portal.helperServices?.serviceArea?.url;
    app.assert(serviceAreaUrl, "This portal does not advertise a service area helper service.");
    const { supportedTravelModes } = await networkService.fetchServiceDescription(serviceAreaUrl);
    automobileTime = (supportedTravelModes ?? []).find((mode) =>
      mode.type === "automobile" && mode.impedanceAttributeName === mode.timeAttributeName
    );
    app.assert(automobileTime, "This service area service offers no time-based driving mode.");
    return { serviceAreaUrl, travelMode: automobileTime };
  };

  const selectStation = async (graphic) => {
    const current = ++requestId;
    selectedGraphic = graphic;
    const precinct = makeStationLabel(graphic);
    status.setAttribute("kind", "info");
    statusTitle.textContent = "Calculating coverage";
    statusMessage.textContent = `Generating a ${app.config.minutes}-minute driving service area for ${precinct}.`;
    try {
      const { serviceAreaUrl, travelMode } = await chooseDrivingTime();
      const result = await serviceArea.solve(serviceAreaUrl, new ServiceAreaParameters({
        facilities: new FeatureSet({ features: [new Graphic({ geometry: graphic.geometry })] }),
        travelMode,
        defaultBreaks: [app.config.minutes],
        outSpatialReference: app.view.spatialReference,
        trimOuterPolygon: true,
      }));
      if (current !== requestId) return { superseded: true };
      const polygons = result.serviceAreaPolygons?.features ?? [];
      await coverage.replaceFeatures(polygons.map((polygon) => ({
        geometry: polygon.geometry,
        attributes: { Precinct: String(graphic.attributes?.Precinct ?? "NYPD"), Minutes: app.config.minutes }
      })));
      await app.view.goTo(graphic.geometry);
      status.setAttribute("kind", "success");
      statusTitle.textContent = "Coverage ready";
      statusMessage.textContent = `${app.config.minutes}-minute driving coverage for ${precinct} is shown on the map.`;
      return { precinct: String(graphic.attributes?.Precinct ?? ""), polygons: polygons.length, minutes: app.config.minutes };
    } catch (error) {
      if (current !== requestId) return { superseded: true };
      status.setAttribute("kind", "danger");
      statusTitle.textContent = "Coverage unavailable";
      statusMessage.textContent = error?.message ?? "The service area could not be calculated.";
      throw error;
    }
  };

  const query = stationLayer.createQuery();
  query.where = "1=1";
  query.outFields = ["FID", "Precinct", "Address", "Type", "Zip_Code"];
  query.returnGeometry = true;
  const result = await stationLayer.queryFeatures(query);
  stations = result.features ?? [];
  statusMessage.textContent = `${stations.length} mapped NYPD station locations are available. Choose one to calculate coverage.`;

  const onInput = (event) => renderMatches(event.target.value);
  input.addEventListener("calciteInputTextInput", onInput);
  app.onCleanup(() => input.removeEventListener("calciteInputTextInput", onInput));
  app.actions.register("select-station", async ({ graphic }) => selectStation(graphic));
  app.onCleanup(() => mount.replaceChildren());
}