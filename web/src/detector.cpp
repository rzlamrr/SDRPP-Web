#include "detector.h"
#include <algorithm>
#include <atomic>

namespace web {
    namespace {
        std::atomic<int> nextId{ 1 };

        constexpr int MERGE_GAP = 2;      // Quiet bins allowed inside one occupied range
        constexpr int MATCH_BINS = 16;    // How far a range may move between lines and still be the same event
        constexpr int CONFIRM_FRAMES = 3; // Lines an event needs before it is reported
        constexpr int DROP_FRAMES = 2;    // Lines after which an unconfirmed event is forgotten
        constexpr int MAX_EVENTS = 64;
        constexpr int FLOOR_UPDATE_FRAMES = 20;

        // Lower quartile of the finite values: the noise floor, as for the SNR in Band::pushFFT
        float lowerQuartile(const std::vector<float>& in, std::vector<float>& scratch) {
            scratch.clear();
            for (float v : in) {
                if (std::isfinite(v)) { scratch.push_back(v); }
            }
            if (scratch.empty()) { return -INFINITY; }
            size_t k = scratch.size() / 4;
            std::nth_element(scratch.begin(), scratch.begin() + k, scratch.end());
            return scratch[k];
        }
    }

    int Detector::learnFrames() const {
        return std::max<int>(5, (int)std::lround(settings.learnSeconds * settings.fftRate));
    }

    // About one second of lines without the event before it is considered over
    int Detector::holdFrames() const {
        return std::max<int>(3, (int)std::lround(settings.fftRate));
    }

    // Absolute frequency of a (fractional) bin edge
    double Detector::binFreq(double bin) const {
        return baseFreq - (baseBandwidth / 2.0) + (bin * binHz);
    }

    void Detector::setSettings(const DetectorSettings& s, std::vector<InterferenceEvent>& closed) {
        bool wasEnabled = settings.enabled;
        settings = s;
        settings.fftRate = std::max<float>(settings.fftRate, 1.0f);
        if (wasEnabled && !settings.enabled) {
            closeAll(lastFrameMs, closed);
            baseFreq = -1.0; // The baseline is learned again once enabled
        }
        if (!ready && bins > 0 && learned >= learnFrames()) {
            ready = true;
            baseFloorDb = lowerQuartile(baseline, scratch);
        }
    }

    void Detector::reset(int64_t nowMs, std::vector<InterferenceEvent>& closed) {
        closeAll(nowMs, closed);
        baseline.assign(bins, 0.0f);
        learned = 0;
        ready = false;
        frame = 0;
        shownFloorDb = NAN;
    }

    void Detector::relearn(int64_t nowMs, std::vector<InterferenceEvent>& closed) {
        if (bins > 0) { reset(nowMs, closed); }
    }

    void Detector::close(InterferenceEvent& e, int64_t, std::vector<InterferenceEvent>& closed) {
        if (!e.confirmed) { return; }
        e.endMs = e.lastMs;
        classify(e);
        closed.push_back(e);
    }

    void Detector::closeAll(int64_t nowMs, std::vector<InterferenceEvent>& closed) {
        for (auto& e : events) { close(e, nowMs, closed); }
        events.clear();
        if (noiseActive) { close(noise, nowMs, closed); }
        noiseActive = false;
    }

    void Detector::classify(InterferenceEvent& e) const {
        if (e.type == "noise") { return; }
        double span = e.maxCenterHz - e.minCenterHz;
        double bw = std::max<double>(e.bandwidthHz, binHz);
        if (e.framesSeen >= 5 && span > std::max<double>(4.0 * bw, 8.0 * binHz)) {
            e.type = "swept";
        }
        else if (e.appearances >= 3 && e.dutyPercent() < 70.0f) {
            e.type = "pulsed";
        }
        else if (e.bandwidthHz <= std::max<double>(25000.0, 3.0 * binHz)) {
            e.type = "narrowband";
        }
        else {
            e.type = "wideband";
        }
    }

    void Detector::see(InterferenceEvent& e, double lowHz, double highHz, double centerHz, float peak, float excess, float snr, int64_t nowMs) {
        // Back after at least one line without it: one more appearance, used for pulses
        if (e.framesSeen == 0 || e.missed > 0) {
            e.appearances++;
            if (e.lastAppearMs > 0) {
                e.periodSumMs += (double)(nowMs - e.lastAppearMs);
                e.periodCount++;
                e.periodMs = e.periodSumMs / e.periodCount;
            }
            e.lastAppearMs = nowMs;
        }
        if (e.framesSeen == 0) {
            e.startMs = nowMs;
            e.firstCenterHz = e.minCenterHz = e.maxCenterHz = centerHz;
        }
        e.seen = true;
        e.missed = 0;
        e.framesSeen++;
        e.framesSpan = e.framesTotal + 1; // This frame is counted when the events are aged
        e.lastMs = nowMs;
        e.lowHz = lowHz;
        e.highHz = highHz;
        e.centerHz = centerHz;
        e.minCenterHz = std::min<double>(e.minCenterHz, centerHz);
        e.maxCenterHz = std::max<double>(e.maxCenterHz, centerHz);
        e.bandwidthHz = std::max<double>(e.bandwidthHz, highHz - lowHz);
        e.peakDb = std::max<float>(e.peakDb, peak);
        e.excessDb = std::max<float>(e.excessDb, excess);
        e.snrDb = std::max<float>(e.snrDb, snr);
        if (!e.confirmed && e.framesSeen >= CONFIRM_FRAMES) {
            e.confirmed = true;
            e.id = nextId++;
        }
        classify(e);
    }

    void Detector::process(const float* raw, int rawSize, double centerFreq, double bandwidth, int64_t nowMs, std::vector<InterferenceEvent>& closed) {
        lastFrameMs = nowMs;
        if (!settings.enabled || rawSize <= 0 || bandwidth <= 0) { return; }

        // A new frequency, sample rate or FFT size makes the baseline meaningless
        int wantedBins = std::min<int>(BINS, rawSize);
        if (centerFreq != baseFreq || bandwidth != baseBandwidth || rawSize != baseRawSize || bins != wantedBins) {
            baseFreq = centerFreq;
            baseBandwidth = bandwidth;
            baseRawSize = rawSize;
            bins = wantedBins;
            binHz = bandwidth / (double)bins;
            reset(nowMs, closed);
        }

        // Reduce to the detector resolution, keeping the highest bin so narrow carriers stay visible
        current.resize(bins);
        double factor = (double)rawSize / (double)bins;
        for (int i = 0; i < bins; i++) {
            int s = (int)(i * factor);
            int e = std::min<int>(std::max<int>(s + 1, (int)((i + 1) * factor)), rawSize);
            float m = -INFINITY;
            for (int j = s; j < e; j++) { m = std::max<float>(m, raw[j]); }
            current[i] = m;
        }

        floorDb = lowerQuartile(current, scratch);
        if (!std::isfinite(floorDb)) { return; }
        shownFloorDb = std::isfinite(shownFloorDb) ? (shownFloorDb * 0.9f) + (floorDb * 0.1f) : floorDb;

        // Learning: the baseline is the mean level of every bin
        if (!ready) {
            learned++;
            for (int i = 0; i < bins; i++) {
                float v = std::isfinite(current[i]) ? current[i] : floorDb;
                baseline[i] += (v - baseline[i]) / (float)learned;
            }
            if (learned >= learnFrames()) {
                ready = true;
                baseFloorDb = lowerQuartile(baseline, scratch);
            }
            return;
        }
        frame++;

        // Occupied bins: above the baseline and above the current noise floor
        float thr = settings.thresholdDb;
        flagged.assign(bins, 0);
        for (int i = 0; i < bins; i++) {
            float v = current[i];
            if (std::isfinite(v) && (v - baseline[i]) > thr && (v - floorDb) > thr) { flagged[i] = 1; }
        }

        // Group them into ranges
        runs.clear();
        for (int i = 0; i < bins;) {
            if (!flagged[i]) {
                i++;
                continue;
            }
            int lo = i, hi = i, gap = 0;
            for (int j = i + 1; j < bins; j++) {
                if (flagged[j]) {
                    hi = j;
                    gap = 0;
                }
                else if (++gap > MERGE_GAP) {
                    break;
                }
            }
            Run r = { lo, hi, -INFINITY, -INFINITY, 0.0f, 0.0 };
            double psum = 0.0, wsum = 0.0;
            for (int j = lo; j <= hi; j++) {
                if (!flagged[j]) {
                    flagged[j] = 1; // Not used to adapt the baseline either
                    continue;
                }
                float v = current[j];
                r.peak = std::max<float>(r.peak, v);
                r.excess = std::max<float>(r.excess, v - baseline[j]);
                double p = std::pow(10.0, v / 10.0);
                psum += p;
                wsum += p * (j + 0.5);
            }
            r.snr = r.peak - floorDb;
            r.center = binFreq(psum > 0.0 ? (wsum / psum) : ((lo + hi + 1) / 2.0));
            runs.push_back(r);
            i = hi + 1;
        }

        // Match each range to the nearest event that overlaps it
        for (auto& e : events) { e.seen = false; }
        owners.assign(runs.size(), -1);
        for (size_t k = 0; k < runs.size(); k++) {
            double lo = binFreq(runs[k].lo);
            double hi = binFreq(runs[k].hi + 1);
            double bestDist = INFINITY;
            for (size_t n = 0; n < events.size(); n++) {
                const auto& e = events[n];
                double margin = std::max<double>(e.bandwidthHz, MATCH_BINS * binHz);
                if (lo > e.highHz + margin || hi < e.lowHz - margin) { continue; }
                double dist = std::fabs(runs[k].center - e.centerHz);
                if (dist < bestDist) {
                    bestDist = dist;
                    owners[k] = (int)n;
                }
            }
        }

        // An event spans all ranges matched to it, centered on the strongest one
        size_t existing = events.size();
        for (size_t n = 0; n < existing; n++) {
            double lo = INFINITY, hi = -INFINITY, center = 0.0;
            float peak = -INFINITY, excess = -INFINITY, snr = -INFINITY;
            for (size_t k = 0; k < runs.size(); k++) {
                if (owners[k] != (int)n) { continue; }
                lo = std::min<double>(lo, binFreq(runs[k].lo));
                hi = std::max<double>(hi, binFreq(runs[k].hi + 1));
                if (runs[k].peak > peak) { center = runs[k].center; }
                peak = std::max<float>(peak, runs[k].peak);
                excess = std::max<float>(excess, runs[k].excess);
                snr = std::max<float>(snr, runs[k].snr);
            }
            if (std::isfinite(lo)) { see(events[n], lo, hi, center, peak, excess, snr, nowMs); }
        }
        for (size_t k = 0; k < runs.size(); k++) {
            if (owners[k] >= 0 || (int)events.size() >= MAX_EVENTS) { continue; }
            InterferenceEvent e;
            e.bandId = bandId;
            see(e, binFreq(runs[k].lo), binFreq(runs[k].hi + 1), runs[k].center, runs[k].peak, runs[k].excess, runs[k].snr, nowMs);
            events.push_back(e);
        }

        // Raised noise floor over the whole band
        float rise = floorDb - baseFloorDb;
        if (rise > settings.noiseRiseDb) {
            if (!noiseActive) {
                noise = InterferenceEvent();
                noise.bandId = bandId;
                noise.type = "noise";
                noiseActive = true;
            }
            see(noise, baseFreq - (baseBandwidth / 2.0), baseFreq + (baseBandwidth / 2.0), baseFreq, floorDb, rise, 0.0f, nowMs);
        }
        else if (noiseActive) {
            noise.seen = false;
        }

        // Age the events and close those that are gone
        int hold = holdFrames();
        auto age = [&](InterferenceEvent& e) {
            e.framesTotal++;
            if (!e.seen) { e.missed++; }
            if (!e.confirmed) { return e.missed >= DROP_FRAMES; }
            return e.missed > hold;
        };
        for (size_t n = 0; n < events.size();) {
            if (age(events[n])) {
                close(events[n], nowMs, closed);
                events.erase(events.begin() + n);
            }
            else {
                n++;
            }
        }
        if (noiseActive && age(noise)) {
            close(noise, nowMs, closed);
            noiseActive = false;
        }

        // Slowly follow changes of the quiet bins. Nothing is learned while the whole floor is raised.
        if (!noiseActive) {
            float alpha = 1.0f / std::max<float>(settings.adaptMinutes * 60.0f * settings.fftRate, 1.0f);
            for (int i = 0; i < bins; i++) {
                if (!flagged[i] && std::isfinite(current[i])) { baseline[i] += alpha * (current[i] - baseline[i]); }
            }
            if (frame % FLOOR_UPDATE_FRAMES == 0) { baseFloorDb = lowerQuartile(baseline, scratch); }
        }
    }

    std::vector<InterferenceEvent> Detector::activeEvents() const {
        std::vector<InterferenceEvent> out;
        for (auto& e : events) {
            if (e.confirmed) { out.push_back(e); }
        }
        if (noiseActive && noise.confirmed) { out.push_back(noise); }
        return out;
    }

    DetectorStatus Detector::status() const {
        DetectorStatus s;
        s.enabled = settings.enabled;
        s.learning = settings.enabled && !ready;
        s.learnProgress = ready ? 1.0f : std::min<float>((float)learned / (float)learnFrames(), 1.0f);
        s.noiseFloorDb = std::isfinite(shownFloorDb) ? shownFloorDb : 0.0f;
        s.baselineFloorDb = ready ? baseFloorDb : 0.0f;
        s.active = 0;
        for (auto& e : events) {
            if (e.confirmed) { s.active++; }
        }
        if (noiseActive && noise.confirmed) { s.active++; }
        return s;
    }
}
