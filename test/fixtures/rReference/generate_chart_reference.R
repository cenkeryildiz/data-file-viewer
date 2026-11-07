# Regenerates chartReference.json from the R plotting helpers (PLOT-01).
#   export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
#   Rscript generate_chart_reference.R <Time_Series_Plotting dir> <out.json>
# Only pure helper functions are called. long_run_3.R is never run (it loads a
# fixed database path). The fixture records the R version and the sha256 of the
# two helper files, so a changed helper shows up as a stale fixture.
args <- commandArgs(trailingOnly = TRUE)
dir <- args[1]; out <- args[2]
suppressPackageStartupMessages(source(file.path(dir, "helpers", "helpers_core.R")))

hash <- function(f) {
  digest <- system2("shasum", c("-a", "256", file.path(dir, f)), stdout = TRUE)
  sub(" .*", "", digest)
}

palette <- lapply(1:60, function(n) I(unname(build_hue_color_map(as.character(seq_len(n))))))

y_cases <- list(
  c(-0.5, 0.25, 1.75),
  c(0, 0),
  c(5, 5),
  c(-3, -3),
  c(1e-9, 2e-9),
  c(1234567, 9876543),
  c(0.0112, 0.0731, 0.0305),
  # all.equal() inside compute_echarts_y_range treats a relative gap below 1.5e-8
  # (absolute below it near zero) as 'no span'.
  c(0, 1e-9), c(1e6, 1e6 + 0.001), c(1e6, 1e6 + 1), c(1, 1 + 1.4e-8), c(1, 1 + 1.6e-8), c(-7, -7 + 1e-9)
)
y_range <- lapply(y_cases, function(v) list(values = I(v), range = I(compute_echarts_y_range(v))))
y_breaks <- lapply(y_cases, function(v) {
  list(lo = min(v), hi = max(v), count = 8, breaks = I(get_forced_breaks(min(v), max(v), numeric(0), 8)))
})

x_cases <- list(c("1961-01-01", "2026-01-01"), c("2020-03-02", "2020-03-20"), c("1999-12-31", "2000-01-03"))
x_range <- lapply(x_cases, function(p) {
  r <- compute_echarts_x_range(as.Date(p[1]), as.Date(p[2]))
  list(start = p[1], end = p[2], min = r[1], max = r[2])
})

dates <- as.Date(c("2020-01-01", "2020-06-30", "2020-07-01", "2020-12-31", "1961-04-15",
                   "2024-02-29", "2026-03-31", "2021-01-07", "2021-01-08", "2020-12-30"))
fmt_of <- function(type) make_label_fn(list(label_type = type))
labels <- lapply(c("quarterly", "semiannual", "weekly"), function(type) {
  list(type = type, dates = I(as.character(dates)), labels = I(fmt_of(type)(dates)))
})

ref <- list(
  generator = "generate_chart_reference.R",
  r_version = R.version.string,
  scales_version = as.character(packageVersion("scales")),
  farver_version = as.character(packageVersion("farver")),
  helpers_core_sha256 = hash("helpers/helpers_core.R"),
  helpers_echarts_sha256 = hash("helpers/helpers_echarts.R"),
  palette = palette, y_range = y_range, y_breaks = y_breaks,
  x_range = x_range, labels = labels,
  # helpers_echarts.R base_echarts_layout()/ec_* values the viewer mirrors.
  style = list(
    line_width = 0.7 * 2, scatter_size = 1.8 * 4, axis_line_width = 1.5,
    split_line = "rgb(229,229,229)", split_line_width = 0.5,
    axis_font_size = 10, legend_font_size = 11, tooltip_font_size = 11, font = "serif",
    grid_left = 10, grid_right = 10, y_ticks = 8
  )
)
writeLines(jsonlite::toJSON(ref, auto_unbox = TRUE, digits = I(17), pretty = TRUE), out)
