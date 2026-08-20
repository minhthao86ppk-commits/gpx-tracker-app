import React, { useState, useEffect, useRef } from 'react';
import { StyleSheet, View, Text, TouchableOpacity, Alert } from 'react-native';
import MapView, { Polyline, Marker, PROVIDER_DEFAULT } from 'react-native-maps';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import * as DocumentPicker from 'expo-document-picker';

const LOCATION_TASK_NAME = 'BACKGROUND_LOCATION_RECORD';
let globalRecordedPoints = [];

// Định nghĩa task chạy ngầm ghi GPS
TaskManager.defineTask(LOCATION_TASK_NAME, ({ data, error }) => {
  if (error) return;
  if (data) {
    const { locations } = data;
    locations.forEach(loc => {
      globalRecordedPoints.push({
        latitude: loc.coords.latitude,
        longitude: loc.coords.longitude,
        altitude: loc.coords.altitude || 0,
        timestamp: new Date(loc.timestamp).toISOString()
      });
    });
  }
});

export default function App() {
  const [currentLoc, setCurrentLoc] = useState(null);
  const [isRecording, setIsRecording] = useState(false);
  const [recordedRoute, setRecordedRoute] = useState([]);
  const [loadedRoute, setLoadedRoute] = useState([]);
  const mapRef = useRef(null);

  useEffect(() => {
    (async () => {
      // Yêu cầu quyền GPS trước và ngầm
      const { status: fgStatus } = await Location.requestForegroundPermissionsAsync();
      if (fgStatus !== 'granted') {
        Alert.alert('Từ chối', 'Vui lòng cấp quyền vị trí để ứng dụng hoạt động.');
        return;
      }
      await Location.requestBackgroundPermissionsAsync();

      // Lấy vị trí ban đầu
      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      setCurrentLoc(loc.coords);
    })();
  }, []);

  // Cập nhật tuyến đường đang vẽ mỗi giây khi bật ghi
  useEffect(() => {
    let interval = null;
    if (isRecording) {
      interval = setInterval(() => {
        setRecordedRoute([...globalRecordedPoints]);
      }, 1000);
    }
    return () => clearInterval(interval);
  }, [isRecording]);

  // Bắt đầu ghi lộ trình
  const startRecording = async () => {
    globalRecordedPoints = [];
    setRecordedRoute([]);
    await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, {
      accuracy: Location.Accuracy.BestForNavigation,
      timeInterval: 1000,
      distanceInterval: 1,
      showsBackgroundLocationIndicator: true,
      foregroundService: {
        notificationTitle: "GPX Tracker",
        notificationBody: "Đang ghi lại lộ trình di chuyển...",
      }
    });
    setIsRecording(true);
  };

  // Dừng ghi & Xuất file .GPX
  const stopRecordingAndExport = async () => {
    const hasStarted = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME);
    if (hasStarted) {
      await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
    }
    setIsRecording(false);

    if (globalRecordedPoints.length === 0) {
      Alert.alert('Thông báo', 'Chưa có tọa độ nào được ghi nhận.');
      return;
    }

    // Tạo nội dung GPX
    const gpxString = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Native GPX Tracker" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>Track_${Date.now()}</name>
    <trkseg>
${globalRecordedPoints.map(p => `      <trkpt lat="${p.latitude}" lon="${p.longitude}"><ele>${p.altitude}</ele><time>${p.timestamp}</time></trkpt>`).join('\n')}
    </trkseg>
  </trk>
</gpx>`;

    const fileUri = `${FileSystem.documentDirectory}track_${Date.now()}.gpx`;
    await FileSystem.writeAsStringAsync(fileUri, gpxString, { encoding: FileSystem.EncodingType.UTF8 });
    await Sharing.shareAsync(fileUri);
  };

  // Nạp file GPX để theo dõi lộ trình
  const importGPX = async () => {
    try {
      const res = await DocumentPicker.getDocumentAsync({ type: '*/*' });
      if (res.canceled || !res.assets || res.assets.length === 0) return;

      const fileContent = await FileSystem.readAsStringAsync(res.assets[0].uri);
      
      // Parser đơn giản trích xuất thẻ <trkpt>
      const regex = /<trkpt\s+lat="([^"]+)"\s+lon="([^"]+)"/g;
      let match;
      const points = [];
      while ((match = regex.exec(fileContent)) !== null) {
        points.push({
          latitude: parseFloat(match[1]),
          longitude: parseFloat(match[2])
        });
      }

      if (points.length === 0) {
        Alert.alert('Lỗi', 'Không tìm thấy tọa độ hợp lệ trong file GPX này.');
        return;
      }

      setLoadedRoute(points);

      // Căn bản đồ hiển thị toàn bộ lộ trình tải lên
      if (mapRef.current) {
        mapRef.current.fitToCoordinates(points, {
          edgePadding: { top: 60, right: 60, bottom: 60, left: 60 },
          animated: true,
        });
      }
    } catch (e) {
      Alert.alert('Lỗi', 'Không thể đọc file GPX.');
    }
  };

  return (
    <View style={styles.container}>
      <MapView
        ref={mapRef}
        style={styles.map}
        provider={PROVIDER_DEFAULT}
        showsUserLocation
        followsUserLocation
        initialRegion={{
          latitude: currentLoc ? currentLoc.latitude : 21.0285,
          longitude: currentLoc ? currentLoc.longitude : 105.8542,
          latitudeDelta: 0.01,
          longitudeDelta: 0.01,
        }}
      >
        {/* Lộ trình đang ghi (màu đỏ) */}
        {recordedRoute.length > 0 && (
          <Polyline coordinates={recordedRoute} strokeColor="#FF3B30" strokeWidth={4} />
        )}

        {/* Lộ trình nạp từ file GPX (màu xanh dương) */}
        {loadedRoute.length > 0 && (
          <>
            <Polyline coordinates={loadedRoute} strokeColor="#007AFF" strokeWidth={5} />
            <Marker coordinate={loadedRoute[0]} title="Điểm bắt đầu" pinColor="green" />
            <Marker coordinate={loadedRoute[loadedRoute.length - 1]} title="Điểm kết thúc" pinColor="red" />
          </>
        )}
      </MapView>

      {/* Thanh công cụ điều khiển */}
      <View style={styles.panel}>
        {!isRecording ? (
          <TouchableOpacity style={[styles.btn, styles.btnStart]} onPress={startRecording}>
            <Text style={styles.btnText}>Bắt đầu ghi</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity style={[styles.btn, styles.btnStop]} onPress={stopRecordingAndExport}>
            <Text style={styles.btnText}>Dừng & Xuất GPX</Text>
          </TouchableOpacity>
        )}

        <TouchableOpacity style={[styles.btn, styles.btnImport]} onPress={importGPX}>
          <Text style={styles.btnText}>Nạp file GPX</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  map: { width: '100%', height: '100%' },
  panel: {
    position: 'absolute',
    bottom: 40,
    left: 20,
    right: 20,
    flexDirection: 'row',
    justifyContent: 'space-between',
    backgroundColor: 'rgba(255, 255, 255, 0.92)',
    padding: 12,
    borderRadius: 20,
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 10,
    elevation: 5,
  },
  btn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
    marginHorizontal: 5,
  },
  btnStart: { backgroundColor: '#34C759' },
  btnStop: { backgroundColor: '#FF3B30' },
  btnImport: { backgroundColor: '#007AFF' },
  btnText: { color: '#FFF', fontWeight: 'bold', fontSize: 14 },
});
