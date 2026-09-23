//! Capture at the device's native rate, downmix to mono in the callback, and on stop
//! resample to 16 kHz and write a PCM16 WAV.

use std::path::Path;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;

use anyhow::{Context, Result, anyhow};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, SizedSample, Stream, StreamConfig};
use rubato::audioadapter_buffers::direct::InterleavedSlice;
use rubato::{Fft, FixedSync, Resampler};

use crate::protocol::{Event, emit, emit_error};

pub const TARGET_RATE: u32 = 16_000;

enum AudioCmd {
    Start { id: u64, device: Option<String> },
    Stop { id: u64, path: String },
    Cancel { id: u64 },
    ListDevices { id: u64 },
}

/// Handle to the audio thread. `cpal::Stream` is `!Send` on macOS,
/// so the stream lives on its own thread and is driven by messages.
#[derive(Clone)]
pub struct Recorder {
    tx: Sender<AudioCmd>,
}

impl Recorder {
    pub fn spawn() -> Self {
        let (tx, rx) = mpsc::channel();
        thread::Builder::new()
            .name("audio".into())
            .spawn(move || audio_thread(rx))
            .expect("failed to spawn audio thread");
        Self { tx }
    }

    pub fn start(&self, id: u64, device: Option<String>) {
        self.send(AudioCmd::Start { id, device });
    }

    pub fn stop(&self, id: u64, path: String) {
        self.send(AudioCmd::Stop { id, path });
    }

    pub fn cancel(&self, id: u64) {
        self.send(AudioCmd::Cancel { id });
    }

    pub fn list_devices(&self, id: u64) {
        self.send(AudioCmd::ListDevices { id });
    }

    fn send(&self, cmd: AudioCmd) {
        if self.tx.send(cmd).is_err() {
            emit_error(None, "audio thread is gone");
        }
    }
}

struct Active {
    stream: Stream,
    buffer: Arc<Mutex<Vec<f32>>>,
    source_rate: u32,
}

fn audio_thread(rx: Receiver<AudioCmd>) {
    let mut active: Option<Active> = None;

    for cmd in rx {
        match cmd {
            AudioCmd::Start { id, device } => {
                if active.is_some() {
                    emit_error(Some(id), "already recording");
                    continue;
                }
                match open(device.as_deref()) {
                    Ok((rec, name)) => {
                        emit(Some(id), Event::Recording { sample_rate: rec.source_rate, device: name });
                        active = Some(rec);
                    }
                    Err(e) => emit_error(Some(id), format!("{e:#}")),
                }
            }
            AudioCmd::Stop { id, path } => {
                let Some(rec) = active.take() else {
                    emit_error(Some(id), "not recording");
                    continue;
                };
                match finish(rec, Path::new(&path)) {
                    Ok(duration_sec) => emit(Some(id), Event::Saved { path, duration_sec }),
                    Err(e) => emit_error(Some(id), format!("{e:#}")),
                }
            }
            AudioCmd::Cancel { id } => {
                // Dropping the stream closes the device.
                active = None;
                emit(Some(id), Event::Cancelled);
            }
            AudioCmd::ListDevices { id } => match list_devices() {
                Ok((devices, default)) => emit(Some(id), Event::Devices { devices, default }),
                Err(e) => emit_error(Some(id), format!("{e:#}")),
            },
        }
    }
}

fn device_name(device: &cpal::Device) -> String {
    device
        .description()
        .map(|d| d.name().to_string())
        .unwrap_or_else(|_| "unknown".into())
}

fn list_devices() -> Result<(Vec<String>, Option<String>)> {
    let host = cpal::default_host();
    let devices = host.input_devices()?.map(|d| device_name(&d)).collect();
    let default = host.default_input_device().map(|d| device_name(&d));
    Ok((devices, default))
}

fn find_device(name: Option<&str>) -> Result<cpal::Device> {
    let host = cpal::default_host();
    match name {
        None | Some("") | Some("default") => host
            .default_input_device()
            .ok_or_else(|| anyhow!("no default input device")),
        Some(name) => host
            .input_devices()?
            .find(|d| device_name(d) == name)
            .ok_or_else(|| anyhow!("input device not found: {name}")),
    }
}

fn open(device_name_hint: Option<&str>) -> Result<(Active, String)> {
    let device = find_device(device_name_hint)?;
    let name = device_name(&device);
    let supported = device
        .default_input_config()
        .context("no default input config")?;
    let format = supported.sample_format();
    let config: StreamConfig = supported.into();
    let source_rate = config.sample_rate;
    let buffer = Arc::new(Mutex::new(Vec::<f32>::with_capacity(source_rate as usize * 30)));

    let buf = buffer.clone();
    let stream = match format {
        SampleFormat::F32 => build::<f32>(&device, config, buf)?,
        SampleFormat::I16 => build::<i16>(&device, config, buf)?,
        SampleFormat::I32 => build::<i32>(&device, config, buf)?,
        SampleFormat::U16 => build::<u16>(&device, config, buf)?,
        other => return Err(anyhow!("unsupported sample format: {other}")),
    };
    stream.play().context("failed to start input stream")?;

    Ok((Active { stream, buffer, source_rate }, name))
}

fn build<T>(device: &cpal::Device, config: StreamConfig, buffer: Arc<Mutex<Vec<f32>>>) -> Result<Stream>
where
    T: SizedSample,
    f32: cpal::FromSample<T>,
{
    let channels = config.channels.max(1) as usize;
    let stream = device.build_input_stream(
        config,
        move |data: &[T], _: &cpal::InputCallbackInfo| {
            // Keep the realtime callback light: downmix only, resample on stop.
            let Ok(mut buf) = buffer.lock() else { return };
            for frame in data.chunks_exact(channels) {
                let sum: f32 = frame.iter().map(|s| s.to_sample::<f32>()).sum();
                buf.push(sum / channels as f32);
            }
        },
        |err| emit_error(None, format!("input stream error: {err}")),
        None,
    )?;
    Ok(stream)
}

fn finish(rec: Active, path: &Path) -> Result<f64> {
    drop(rec.stream);
    let mono = std::mem::take(&mut *rec.buffer.lock().map_err(|_| anyhow!("buffer poisoned"))?);
    if mono.is_empty() {
        return Err(anyhow!("empty recording"));
    }
    let resampled = resample(&mono, rec.source_rate, TARGET_RATE)?;
    let samples = to_i16(&resampled);
    write_wav(path, &samples)?;
    Ok(samples.len() as f64 / TARGET_RATE as f64)
}

pub fn resample(input: &[f32], from: u32, to: u32) -> Result<Vec<f32>> {
    if from == to || input.is_empty() {
        return Ok(input.to_vec());
    }
    let mut resampler = Fft::<f32>::new(from as usize, to as usize, 1024, 1, FixedSync::Both)?;
    let adapter = InterleavedSlice::new(input, 1, input.len())?;
    let out = resampler.process_all(&adapter, input.len(), None)?;
    Ok(out.take_data())
}

pub fn to_i16(samples: &[f32]) -> Vec<i16> {
    samples
        .iter()
        .map(|s| (s.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16)
        .collect()
}

pub fn write_wav(path: &Path, samples: &[i16]) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).with_context(|| format!("cannot create {}", parent.display()))?;
    }
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: TARGET_RATE,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer =
        hound::WavWriter::create(path, spec).with_context(|| format!("cannot write {}", path.display()))?;
    for &s in samples {
        writer.write_sample(s)?;
    }
    writer.finalize()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resamples_48k_to_16k() {
        let input: Vec<f32> = (0..48_000)
            .map(|i| (i as f32 * 440.0 * std::f32::consts::TAU / 48_000.0).sin() * 0.5)
            .collect();
        let out = resample(&input, 48_000, TARGET_RATE).unwrap();
        assert!((out.len() as i64 - 16_000).abs() <= 1, "len = {}", out.len());
    }

    #[test]
    fn clamps_to_i16() {
        assert_eq!(to_i16(&[0.0, 1.0, -1.0, 2.0, -2.0]), vec![0, 32767, -32767, 32767, -32767]);
    }

    #[test]
    fn writes_valid_wav() {
        let dir = std::env::temp_dir().join(format!("asr-helper-test-{}", std::process::id()));
        let path = dir.join("nested/out.wav");
        write_wav(&path, &[0, 1000, -1000]).unwrap();
        let reader = hound::WavReader::open(&path).unwrap();
        let spec = reader.spec();
        assert_eq!((spec.channels, spec.sample_rate, spec.bits_per_sample), (1, 16_000, 16));
        assert_eq!(reader.len(), 3);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
